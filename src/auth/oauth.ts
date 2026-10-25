import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createCodeVerifier, pkceChallenge, randomString } from '../util/crypto.js';
import { openBrowser } from '../util/browser.js';
import { log } from '../util/logger.js';
import type { StoredClient, StoredToken } from './store.js';

export type { StoredClient, StoredToken } from './store.js';

export const DEFAULT_SERVER_URL = 'https://mcp.figma.com/mcp';
export const DEFAULT_AUTH_SERVER = 'https://api.figma.com';
export const DEFAULT_SCOPE = 'mcp:connect';

export interface OAuthConfig {
  serverUrl: string;
  authServer: string;
  scope: string;
}

/**
 * fetch with a short retry/backoff.
 * Figma's edge (CloudFront) intermittently drops connections, and a single
 * failed metadata request should not kill the whole login.
 */
async function fetchWithRetry(
  url: string,
  init: RequestInit = {},
  attempts = 3,
): Promise<Response> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const res = await fetch(url, {
        ...init,
        signal: init.signal ?? AbortSignal.timeout(30_000),
      });
      if (res.status >= 500 && attempt < attempts) {
        lastError = new Error(`HTTP ${res.status}`);
        await sleep(400 * attempt);
        continue;
      }
      return res;
    } catch (err) {
      lastError = err;
      if (attempt < attempts) {
        log.debug(`请求 ${url} 失败 (${(err as Error).message})，第 ${attempt} 次重试`);
        await sleep(600 * attempt);
        continue;
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function loadOAuthConfig(): Promise<OAuthConfig> {
  const serverUrl = process.env.FIGMA_MCP_SERVER_URL?.trim() || DEFAULT_SERVER_URL;
  let authServer = DEFAULT_AUTH_SERVER;
  let scope = DEFAULT_SCOPE;

  try {
    const res = await fetchWithRetry(`${serverUrl}/.well-known/oauth-protected-resource`, {
      headers: { accept: 'application/json' },
    });
    if (res.ok) {
      const meta = (await res.json()) as {
        authorization_servers?: string[];
        scopes_supported?: string[];
      };
      if (meta.authorization_servers?.[0]) authServer = meta.authorization_servers[0];
      if (meta.scopes_supported?.length) scope = meta.scopes_supported.join(' ');
    }
  } catch {
    /* fall back to defaults */
  }

  return { serverUrl, authServer, scope };
}

interface AsMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  code_challenge_methods_supported?: string[];
  scopes_supported?: string[];
  require_state_parameter?: boolean;
}

export async function loadAuthServerMetadata(authServer: string): Promise<AsMetadata> {
  const res = await fetchWithRetry(`${authServer}/.well-known/oauth-authorization-server`, {
    headers: { accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`无法读取 OAuth 元数据 (${res.status}) from ${authServer}`);
  }
  return (await res.json()) as AsMetadata;
}

/**
 * Register an OAuth client via Dynamic Client Registration.
 *
 * NOTE: Figma's registration endpoint only accepts client names that exist in
 * the Figma MCP catalog — arbitrary names are rejected with HTTP 403.
 * The name is configurable so users can pick the catalog entry that matches
 * their client (see README).
 */
export async function registerClient(
  metadata: AsMetadata,
  redirectUri: string,
  clientName: string,
): Promise<StoredClient> {
  if (!metadata.registration_endpoint) {
    throw new Error('该 OAuth 服务器不支持动态注册 (no registration_endpoint)');
  }

  // NOTE: Figma's registration endpoint only accepts a JSON body —
  // sending application/x-www-form-urlencoded is rejected with HTTP 403.
  const body = {
    client_name: clientName,
    redirect_uris: [redirectUri],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'client_secret_post',
    scope: DEFAULT_SCOPE,
  };

  const res = await fetchWithRetry(metadata.registration_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    if (res.status === 403) {
      throw new Error(
        `Figma 拒绝了客户端注册 (403)。client_name "${clientName}" 不在其允许名单内。\n` +
          `请用 --client-name 指定 Figma MCP 目录中的名称。\n` +
          `响应: ${text.slice(0, 200)}`,
      );
    }
    throw new Error(`客户端注册失败 (${res.status}): ${text.slice(0, 200)}`);
  }

  const json = (await res.json()) as {
    client_id: string;
    client_secret?: string;
    redirect_uris?: string[];
    client_name?: string;
  };

  if (!json.client_id) throw new Error('客户端注册响应缺少 client_id');

  return {
    client_id: json.client_id,
    client_secret: json.client_secret ?? '',
    client_name: json.client_name ?? clientName,
    redirect_uris: json.redirect_uris ?? [redirectUri],
  };
}

export interface AuthorizeResult {
  code: string;
  redirectUri: string;
  codeVerifier: string;
  state: string;
}

export interface CallbackServer {
  redirectUri: string;
  /** The `state` value the server expects to see in the callback. */
  state: string;
  /** The PKCE verifier bound to this callback. */
  codeVerifier: string;
  waitForCode: (timeoutMs: number) => Promise<AuthorizeResult>;
  close: () => Promise<void>;
}

/** Start a loopback HTTP server that captures the OAuth authorization code. */
export async function startCallbackServer(
  options: { port?: number; codeVerifier?: string } = {},
): Promise<CallbackServer> {
  const server = createServer();
  const state = randomString(24);
  const codeVerifier = options.codeVerifier ?? createCodeVerifier();
  let resolveCode: ((value: AuthorizeResult) => void) | undefined;
  let rejectCode: ((err: Error) => void) | undefined;

  const pending = new Promise<AuthorizeResult>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/callback') {
      res.writeHead(404).end('Not found');
      return;
    }

    const error = url.searchParams.get('error');
    const errorDescription = url.searchParams.get('error_description');
    if (error) {
      res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' }).end(html(
        `授权失败: ${error}${errorDescription ? ` — ${errorDescription}` : ''}`,
      ));
      rejectCode?.(new Error(`授权失败: ${error}${errorDescription ? ` — ${errorDescription}` : ''}`));
      return;
    }

    const returnedState = url.searchParams.get('state');
    if (returnedState !== state) {
      res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' }).end(html('state 校验失败'));
      rejectCode?.(new Error('state 校验失败，可能不是本次授权请求的回调'));
      return;
    }

    // RFC 9207 / Figma: the authorization response carries an issuer parameter.
    const iss = url.searchParams.get('iss');
    if (iss && iss !== 'https://api.figma.com' && iss !== 'https://api.figma.com/') {
      res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' }).end(html('iss 校验失败'));
      rejectCode?.(new Error(`iss 校验失败: ${iss}`));
      return;
    }

    const code = url.searchParams.get('code');
    if (!code) {
      res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' }).end(html('缺少 code 参数'));
      rejectCode?.(new Error('回调缺少 code 参数'));
      return;
    }

    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html('授权成功，可以关闭本页面。'));
    resolveCode?.({
      code,
      redirectUri: `http://127.0.0.1:${(server.address() as AddressInfo).port}/callback`,
      codeVerifier,
      state,
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', () => resolve());
  });

  const actualPort = (server.address() as AddressInfo).port;

  return {
    redirectUri: `http://127.0.0.1:${actualPort}/callback`,
    state,
    codeVerifier,
    waitForCode: async (timeoutMs: number) => {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('等待授权回调超时')), timeoutMs);
      });
      try {
        return await Promise.race([pending, timeout]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

export interface AuthorizeOptions {
  metadata: AsMetadata;
  client: StoredClient;
  redirectUri: string;
  codeVerifier: string;
  state: string;
  scope: string;
  resource: string;
}

export function buildAuthorizeUrl(opts: AuthorizeOptions): string {
  const url = new URL(opts.metadata.authorization_endpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', opts.client.client_id);
  url.searchParams.set('redirect_uri', opts.redirectUri);
  url.searchParams.set('code_challenge', pkceChallenge(opts.codeVerifier));
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', opts.state);
  url.searchParams.set('scope', opts.scope);
  url.searchParams.set('resource', opts.resource);
  return url.toString();
}

export async function exchangeCode(
  metadata: AsMetadata,
  client: StoredClient,
  code: string,
  redirectUri: string,
  codeVerifier: string,
): Promise<StoredToken> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
    client_id: client.client_id,
  });
  if (client.client_secret) body.set('client_secret', client.client_secret);

  const res = await fetchWithRetry(metadata.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(30_000),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`令牌交换失败 (${res.status}): ${text.slice(0, 300)}`);
  }
  return parseTokenResponse(text);
}

export async function refreshAccessToken(
  metadata: AsMetadata,
  client: StoredClient,
  refreshToken: string,
): Promise<StoredToken> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: client.client_id,
  });
  if (client.client_secret) body.set('client_secret', client.client_secret);

  const res = await fetchWithRetry(metadata.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(30_000),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`刷新令牌失败 (${res.status}): ${text.slice(0, 300)}`);
  }
  return parseTokenResponse(text);
}

function parseTokenResponse(text: string): StoredToken {
  const json = JSON.parse(text) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    id_token?: string;
    token_type?: string;
  };
  if (!json.access_token) throw new Error('令牌响应缺少 access_token');
  return {
    access_token: json.access_token,
    ...(json.refresh_token ? { refresh_token: json.refresh_token } : {}),
    ...(json.expires_in ? { expires_at: Date.now() + json.expires_in * 1000 } : {}),
    ...(json.scope ? { scope: json.scope } : {}),
    ...(json.id_token ? { id_token: json.id_token } : {}),
  };
}

/** Best-effort read of the account email from the OIDC id_token (display only). */
export function decodeIdToken(idToken?: string): { email?: string; name?: string } {
  if (!idToken) return {};
  try {
    const payload = idToken.split('.')[1];
    if (!payload) return {};
    const json = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      email?: string;
      name?: string;
    };
    return { ...(json.email ? { email: json.email } : {}), ...(json.name ? { name: json.name } : {}) };
  } catch {
    return {};
  }
}

function html(message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Figma MCP CLI</title></head>
<body style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;padding:48px;text-align:center">
<h2>Figma MCP CLI</h2><p>${escapeHtml(message)}</p></body></html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&#38;')
    .replace(/</g, '&#60;')
    .replace(/>/g, '&#62;')
    .replace(/"/g, '&#34;');
}
