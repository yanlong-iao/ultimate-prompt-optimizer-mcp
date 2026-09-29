// stdout is reserved for the MCP stdio protocol — every log line goes to stderr.
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type LogLevel = keyof typeof LEVELS;

let current: LogLevel = "info";
export function setLogLevel(level: LogLevel) {
  current = level;
}

function emit(level: LogLevel, msg: string, extra?: unknown) {
  if (LEVELS[level] < LEVELS[current]) return;
  const line = `[upo ${new Date().toISOString()}] ${level.toUpperCase()} ${msg}`;
  if (extra !== undefined) {
    const detail = extra instanceof Error ? extra.stack ?? extra.message : JSON.stringify(extra);
    process.stderr.write(`${line} ${detail}\n`);
  } else {
    process.stderr.write(`${line}\n`);
  }
}

export const log = {
  debug: (m: string, e?: unknown) => emit("debug", m, e),
  info: (m: string, e?: unknown) => emit("info", m, e),
  warn: (m: string, e?: unknown) => emit("warn", m, e),
  error: (m: string, e?: unknown) => emit("error", m, e),
};
