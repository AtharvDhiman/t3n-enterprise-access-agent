/**
 * Minimal structured logger.
 *
 * Deliberately not a dependency: the only feature this project needs beyond
 * `console` is that **every payload passes through `redact()`**, and that is
 * easier to guarantee in 40 lines than to configure in a logging framework.
 */

import { redact, scrubText } from "./redact.ts";

export const LOG_LEVELS = ["debug", "info", "warn", "error", "silent"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

export interface Logger {
  debug(msg: string, meta?: unknown): void;
  info(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
  error(msg: string, meta?: unknown): void;
  child(scope: string): Logger;
}

function normalizeLevel(value: string | undefined): LogLevel {
  const v = (value ?? "info").toLowerCase();
  return (LOG_LEVELS as readonly string[]).includes(v) ? (v as LogLevel) : "info";
}

export function createLogger(scope: string, level?: LogLevel): Logger {
  const active = level ?? normalizeLevel(process.env.LOG_LEVEL);

  const emit = (lvl: Exclude<LogLevel, "silent">, msg: string, meta?: unknown): void => {
    if (RANK[lvl] < RANK[active]) return;
    const line: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level: lvl,
      scope,
      msg: scrubText(msg),
    };
    if (meta !== undefined) line.meta = redact(meta);
    const serialized = JSON.stringify(line);
    if (lvl === "error") process.stderr.write(`${serialized}\n`);
    else process.stdout.write(`${serialized}\n`);
  };

  return {
    debug: (m, meta) => emit("debug", m, meta),
    info: (m, meta) => emit("info", m, meta),
    warn: (m, meta) => emit("warn", m, meta),
    error: (m, meta) => emit("error", m, meta),
    child: (sub) => createLogger(`${scope}:${sub}`, active),
  };
}
