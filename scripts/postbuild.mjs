// Make the compiled CLI entry directly executable on POSIX systems.
import { chmodSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const entry = join(root, 'dist', 'cli.js');

if (existsSync(entry)) {
  chmodSync(entry, 0o755);
  console.log(`chmod +x ${entry}`);
}
