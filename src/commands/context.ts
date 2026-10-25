import { AuthError, McpClient } from '../mcp/client.js';
import {
  decodeIdToken,
  loadAuthServerMetadata,
  loadOAuthConfig,
  refreshAccessToken,
  type OAuthConfig,
} from '../auth/oauth.js';
import { loadCredentials, saveCredentials, type Credentials } from '../auth/store.js';
import { log } from '../util/logger.js';

export interface ClientContext {
  client: McpClient;
  credentials: Credentials;
  config: OAuthConfig;
}

/** Load the stored credentials, refreshing the access token when it is about to expire. */
export async function loadFreshCredentials(): Promise<{ creds: Credentials; config: OAuthConfig }> {
  const config = await loadOAuthConfig();
  const creds = await loadCredentials();

  if (!creds) {
    throw new Error('尚未登录，请先运行: fmcp login');
  }

  const expiresAt = creds.token.expires_at;
  const needsRefresh = typeof expiresAt === 'number' && expiresAt - Date.now() < 60_000;

  if (needsRefresh && creds.token.refresh_token) {
    const metadata = await loadAuthServerMetadata(config.authServer);
    const token = await refreshAccessToken(metadata, creds.client, creds.token.refresh_token);
    const updated: Credentials = {
      ...creds,
      token: {
        ...creds.token,
        access_token: token.access_token,
        ...(token.refresh_token ? { refresh_token: token.refresh_token } : {}),
        ...(token.expires_at ? { expires_at: token.expires_at } : {}),
        ...(token.scope ? { scope: token.scope } : {}),
      },
    };
    await saveCredentials(updated);
    return { creds: updated, config };
  }

  return { creds, config };
}

/**
 * Connect to the Figma MCP server with the stored credentials.
 * A 401 triggers exactly one refresh + retry.
 */
export async function connect(options: { timeoutMs?: number } = {}): Promise<ClientContext> {
  const { creds, config } = await loadFreshCredentials();

  const build = (): McpClient =>
    new McpClient({
      serverUrl: config.serverUrl,
      accessToken: creds.token.access_token,
      timeoutMs: options.timeoutMs,
    });

  let client = build();
  try {
    await client.initialize();
    return { client, credentials: creds, config };
  } catch (err) {
    if (!(err instanceof AuthError)) throw err;

    if (!creds.token.refresh_token) {
      throw new Error('访问令牌已失效，请重新运行: fmcp login');
    }

    log.info('令牌已过期，尝试刷新...');
    const metadata = await loadAuthServerMetadata(config.authServer);
    const token = await refreshAccessToken(metadata, creds.client, creds.token.refresh_token);
    const updated: Credentials = {
      ...creds,
      token: {
        ...creds.token,
        access_token: token.access_token,
        ...(token.refresh_token ? { refresh_token: token.refresh_token } : {}),
        ...(token.expires_at ? { expires_at: token.expires_at } : {}),
      },
    };
    await saveCredentials(updated);

    client = new McpClient({
      serverUrl: config.serverUrl,
      accessToken: updated.token.access_token,
      timeoutMs: options.timeoutMs,
    });
    await client.initialize();
    return { client, credentials: updated, config };
  }
}

export function describeIdentity(creds: Credentials): string {
  const identity = decodeIdToken(creds.token.id_token);
  return identity.email ?? identity.name ?? '未知账户';
}
