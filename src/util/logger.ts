export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';

const LEVELS: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

let current: LogLevel = 'info';

export function setLogLevel(level: LogLevel): void {
  current = level;
}

export function getLogLevel(): LogLevel {
  return current;
}

function emit(level: Exclude<LogLevel, 'silent'>, stream: 'stderr' | 'stdout', args: unknown[]): void {
  if (LEVELS[current] < LEVELS[level]) return;
  const line = args
    .map((a) => (typeof a === 'string' ? a : inspect(a)))
    .join(' ');
  (stream === 'stdout' ? process.stdout : process.stderr).write(`${line}\n`);
}

function inspect(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export const log = {
  error: (...args: unknown[]) => emit('error', 'stderr', args),
  warn: (...args: unknown[]) => emit('warn', 'stderr', args),
  info: (...args: unknown[]) => emit('info', 'stderr', args),
  debug: (...args: unknown[]) => emit('debug', 'stderr', args),
  /** Plain stdout output — always emitted, used for command results. */
  out: (...args: unknown[]) => process.stdout.write(`${args.map((a) => (typeof a === 'string' ? a : inspect(a))).join(' ')}\n`),
};

export function fail(message: string, code = 1): never {
  log.error(`错误: ${message}`);
  process.exit(code);
}
