import * as core from "@actions/core";

export type LogLevel = "debug" | "info" | "warn" | "error";

const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

let level: LogLevel = "info";
let initialized = false;

function parseLevel(raw: string): LogLevel {
  const v = raw.trim().toLowerCase();
  if (v === "debug" || v === "info" || v === "warn" || v === "error") return v;
  core.warning(`Unknown log-level '${raw}', falling back to info`);
  return "info";
}

/** Call once at startup (reads the log-level action input, default info). */
export function initLogger(): LogLevel {
  if (!initialized) {
    try {
      level = parseLevel(core.getInput("log-level") || "info");
    } catch {
      level = "info";
    }
    initialized = true;
    core.info(`OpenReview log level: ${level}`);
  }
  return level;
}

/** Test hook: pin the level without reading action inputs. */
export function setLogLevelForTests(next: LogLevel): void {
  level = next;
  initialized = true;
}

function enabled(at: LogLevel): boolean {
  return ORDER[at] >= ORDER[level];
}

export function logDebug(message: string): void {
  if (enabled("debug")) core.debug(message);
}

export function logInfo(message: string): void {
  if (enabled("info")) core.info(message);
}

export function logWarning(message: string): void {
  if (enabled("warn")) core.warning(message);
}

function redactUrl(url: string): string {
  return url; // URLs never carry keys in this codebase (keys go in headers)
}

export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const low = k.toLowerCase();
    // Never print key material: scheme prefix only (e.g. "Bearer"), never the key.
    out[k] =
      low === "authorization" || low === "x-api-key" || low === "api-key"
        ? v
          ? v.replace(/\S+$/, "***")
          : "(not set)"
        : v;
  }
  return out;
}

export { redactUrl };
