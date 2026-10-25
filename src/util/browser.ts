import { spawn } from 'node:child_process';
import { platform } from 'node:os';

/**
 * Open a URL in the user's default browser.
 * Falls back to printing the URL when no browser can be launched.
 */
export async function openBrowser(url: string): Promise<boolean> {
  const os = platform();
  try {
    if (os === 'win32') {
      // `start` treats the first quoted arg as the window title, hence the empty "".
      await run('cmd', ['/c', 'start', '', url]);
      return true;
    }
    if (os === 'darwin') {
      await run('open', [url]);
      return true;
    }
    await run('xdg-open', [url]);
    return true;
  } catch {
    return false;
  }
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}
