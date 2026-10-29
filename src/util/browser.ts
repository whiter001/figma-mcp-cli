import { spawn } from 'node:child_process';
import { platform } from 'node:os';

/** A ready-to-spawn command that opens a URL with the default browser. */
export interface OpenCommand {
  /** Executable to launch. */
  cmd: string;
  /** Argument vector, exactly as it should reach the executable. */
  args: string[];
  /**
   * Skip node's own Windows argument escaping. cmd.exe parses the command
   * line itself, so the quotes have to reach it verbatim.
   */
  windowsVerbatimArguments?: boolean;
}

/**
 * Build the command that opens `url` in the user's default browser.
 *
 * On Windows we go through `cmd /c start`. cmd re-parses the command line it
 * is handed, so an unquoted `&` inside the URL ends the command: the browser
 * would only receive the part before the first `&`, and everything after it
 * would be run as a separate command. The URL therefore has to be quoted.
 *
 * Quoting alone is not enough — node escapes the quotes to `\"`, which makes
 * cmd close the quoted section early and makes the `&` special again. Node's
 * own escaping is therefore switched off for this call.
 */
export function buildOpenCommand(os: string, url: string): OpenCommand {
  if (os === 'win32') {
    // `start` treats the first quoted argument as the window title, hence the empty "".
    return {
      cmd: 'cmd',
      args: ['/c', 'start', '""', `"${encodeQuotes(url)}"`],
      windowsVerbatimArguments: true,
    };
  }
  if (os === 'darwin') {
    return { cmd: 'open', args: [url] };
  }
  return { cmd: 'xdg-open', args: [url] };
}

/**
 * A raw `"` would close cmd's quoted section early. URLs produced by the URL
 * API never contain one unescaped, but this helper is generic.
 */
function encodeQuotes(url: string): string {
  return url.replace(/"/g, '%22');
}

/**
 * Open a URL in the user's default browser.
 * Falls back to printing the URL when no browser can be launched.
 */
export async function openBrowser(url: string): Promise<boolean> {
  const spec = buildOpenCommand(platform(), url);
  try {
    await run(spec);
    return true;
  } catch {
    return false;
  }
}

function run(spec: OpenCommand): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(spec.cmd, spec.args, {
      stdio: 'ignore',
      detached: true,
      windowsVerbatimArguments: spec.windowsVerbatimArguments,
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}
