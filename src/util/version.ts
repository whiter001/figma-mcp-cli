import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Read the version from the package manifest so it never drifts from
 * package.json. The compiled entry lives in dist/, the manifest one level
 * above it, so walk up until a real manifest turns up.
 */
export function packageVersion(): string {
  try {
    let here = dirname(fileURLToPath(import.meta.url));

    for (let i = 0; i < 4; i += 1) {
      const candidate = join(here, 'package.json');
      if (existsSync(candidate)) {
        const manifest = JSON.parse(readFileSync(candidate, 'utf8')) as { name?: string; version?: string };
        // A manifest without a name is a stray file, not our package.json.
        if (manifest.name && manifest.version) return manifest.version;
      }
      here = resolve(here, '..');
    }
  } catch {
    /* fall through */
  }
  return '0.0.0';
}

/** Keep createRequire imported for consumers that need it. */
export const requireFrom = createRequire(import.meta.url);
