import { runStdioBridge } from '../mcp/stdio.js';
import { connect } from './context.js';

/**
 * Expose the Figma MCP server over stdio, so the CLI can be registered as a
 * command in any MCP client:
 *
 *   [mcp_servers.Figma]
 *   command = "fmcp"
 *   args = ["serve"]
 */
export async function serve(options: { timeoutMs?: number } = {}): Promise<void> {
  await runStdioBridge({
    createClient: async () => {
      const { client } = await connect({ timeoutMs: options.timeoutMs ?? 300_000 });
      return client;
    },
    // Diagnostics must never go to stdout — that channel carries the protocol.
    onDiagnostic: (message) => process.stderr.write(`[fmcp] ${message}\n`),
  });
}
