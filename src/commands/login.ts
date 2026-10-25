import {
  buildAuthorizeUrl,
  exchangeCode,
  loadAuthServerMetadata,
  loadOAuthConfig,
  registerClient,
  startCallbackServer,
  type StoredClient,
} from '../auth/oauth.js';
import { saveCredentials, type Credentials } from '../auth/store.js';
import { openBrowser } from '../util/browser.js';
import { createCodeVerifier } from '../util/crypto.js';
import { log } from '../util/logger.js';
import { McpClient } from '../mcp/client.js';

export interface LoginOptions {
  clientName?: string;
  /** Do not launch a browser; just print the authorization URL. */
  noOpen?: boolean;
  /** How long to wait for the browser callback (ms). */
  timeoutMs?: number;
}

export const DEFAULT_CLIENT_NAME = 'Codex';

export async function login(options: LoginOptions = {}): Promise<void> {
  const config = await loadOAuthConfig();
  const metadata = await loadAuthServerMetadata(config.authServer);
  const clientName = options.clientName?.trim() || process.env.FIGMA_MCP_CLIENT_NAME?.trim() || DEFAULT_CLIENT_NAME;

  const codeVerifier = createCodeVerifier();
  const callback = await startCallbackServer({ codeVerifier });

  let client: StoredClient;
  try {
    log.info(`正在注册 OAuth 客户端 (client_name=${clientName})...`);
    client = await registerClient(metadata, callback.redirectUri, clientName);
  } catch (err) {
    await callback.close();
    throw err;
  }

  const authorizeUrl = buildAuthorizeUrl({
    metadata,
    client,
    redirectUri: callback.redirectUri,
    codeVerifier,
    state: callback.state,
    scope: config.scope,
    resource: config.serverUrl,
  });

  log.info('');
  log.info('请在浏览器中完成 Figma 授权（点击 "Allow access"）:');
  log.info(authorizeUrl);
  log.info('');
  log.info(`等待回调: ${callback.redirectUri}`);

  if (!options.noOpen) {
    const opened = await openBrowser(authorizeUrl);
    if (!opened) log.warn('无法自动打开浏览器，请手动复制上面的链接。');
  }

  const timeoutMs = options.timeoutMs ?? 300_000;

  try {
    const result = await callback.waitForCode(timeoutMs);
    log.info('收到授权码，正在换取令牌...');

    const token = await exchangeCode(
      metadata,
      client,
      result.code,
      result.redirectUri,
      result.codeVerifier,
    );

    const credentials: Credentials = {
      version: 1,
      server: config.serverUrl,
      client,
      token,
    };

    const path = await saveCredentials(credentials);
    log.info(`凭据已保存: ${path}`);

    // Verify the connection end-to-end.
    const mcp = new McpClient({
      serverUrl: config.serverUrl,
      accessToken: token.access_token,
      timeoutMs: 120_000,
    });
    await mcp.initialize();
    const tools = await mcp.listTools();
    await mcp.close();

    log.info(`登录成功 — 服务器暴露 ${tools.length} 个工具: ${tools.map((t) => t.name).join(', ')}`);
  } finally {
    await callback.close();
  }
}
