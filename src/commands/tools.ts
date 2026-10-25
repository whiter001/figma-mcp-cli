import { log } from '../util/logger.js';
import { connect } from './context.js';

export interface ToolsOptions {
  json?: boolean;
  /** Show the full input schema of each tool. */
  schemas?: boolean;
}

export async function tools(options: ToolsOptions = {}): Promise<void> {
  const { client } = await connect({ timeoutMs: 60_000 });
  const list = await client.listTools();
  await client.close();

  if (options.json) {
    log.out(JSON.stringify(list, null, 2));
    return;
  }

  if (list.length === 0) {
    log.out('服务端没有暴露任何工具。');
    return;
  }

  for (const tool of list) {
    const title = tool.title ? ` — ${tool.title}` : '';
    log.out(`${tool.name}${title}`);
    if (tool.description) {
      const description = tool.description.replace(/\s+/g, ' ').trim();
      log.out(`  ${description}`);
    }
    if (options.schemas && tool.inputSchema) {
      log.out(`  schema: ${JSON.stringify(tool.inputSchema)}`);
    }
  }
}
