import { loadCredentials, credentialsPath } from '../auth/store.js';
import { loadOAuthConfig } from '../auth/oauth.js';
import { log } from '../util/logger.js';
import { connect, describeIdentity } from './context.js';
import type { CallToolResult } from '../mcp/client.js';

export interface StatusOptions {
  json?: boolean;
  /** Skip the live round-trip to the server. */
  offline?: boolean;
}

/** Ask the server who we are — the OAuth token may not carry an id_token. */
async function fetchIdentity(client: { callTool: (name: string, args?: Record<string, unknown>) => Promise<CallToolResult> }): Promise<string | undefined> {
  try {
    const result = await client.callTool('whoami', {});
    const text = (result.content ?? [])
      .filter((c) => c.type === 'text')
      .map((c) => (c as { text: string }).text)
      .join('\n');
    const payload = JSON.parse(text) as { whoami?: { email?: string; handle?: string } };
    const who = payload.whoami;
    if (!who) return undefined;
    if (who.email && who.handle) return `${who.email} (${who.handle})`;
    return who.email ?? who.handle;
  } catch {
    return undefined;
  }
}

export async function status(options: StatusOptions = {}): Promise<void> {
  const config = await loadOAuthConfig();
  const creds = await loadCredentials();

  if (!creds) {
    if (options.json) {
      log.out(JSON.stringify({ loggedIn: false, server: config.serverUrl }, null, 2));
      return;
    }
    log.out(`未登录。服务器: ${config.serverUrl}`);
    log.out('运行 `fmcp login` 完成授权。');
    return;
  }

  const expiresAt = creds.token.expires_at;
  const expiresIn = expiresAt ? Math.round((expiresAt - Date.now()) / 1000) : undefined;
  let identity = describeIdentity(creds);

  let tools: string[] | undefined;
  let liveError: string | undefined;

  if (!options.offline) {
    try {
      const { client } = await connect({ timeoutMs: 60_000 });
      tools = (await client.listTools()).map((t) => t.name);
      identity = (await fetchIdentity(client)) ?? identity;
      await client.close();
    } catch (err) {
      liveError = err instanceof Error ? err.message : String(err);
    }
  }

  if (options.json) {
    log.out(
      JSON.stringify(
        {
          loggedIn: true,
          server: creds.server || config.serverUrl,
          account: identity,
          clientName: creds.client.client_name,
          scope: creds.token.scope,
          expiresAt: expiresAt ? new Date(expiresAt).toISOString() : undefined,
          expiresInSeconds: expiresIn,
          credentialsPath: credentialsPath(),
          tools,
          error: liveError,
        },
        null,
        2,
      ),
    );
    return;
  }

  log.out(`服务器      : ${creds.server || config.serverUrl}`);
  log.out(`账户        : ${identity}`);
  log.out(`客户端      : ${creds.client.client_name} (${creds.client.client_id})`);
  log.out(`权限范围    : ${creds.token.scope ?? '(未知)'}`);
  log.out(`凭据文件    : ${credentialsPath()}`);
  log.out(`令牌有效期  : ${expiresIn !== undefined ? `${expiresIn}s 后过期` : '(未知)'}`);
  if (tools) {
    log.out(`可用工具    : ${tools.length} 个 — ${tools.join(', ')}`);
  }
  if (liveError) {
    log.warn(`连接检查失败: ${liveError}`);
  }
}
