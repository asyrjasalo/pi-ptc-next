import { formatWithOptions } from "util";
import type { PtcSettings } from "./contracts/settings";

const DEFAULT_MAX_OUTPUT_SIZE = 100_000;
const DEFAULT_EXECUTION_TIMEOUT_MS = 270_000;
const DEFAULT_MAX_PARALLEL_TOOL_CALLS = 8;
const DEBUG_PREFIX = "[PTC]";

let debugLoggingEnabled = false;

function parseBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function parsePositiveIntEnv(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseListEnv(value: string | undefined): string[] | undefined {
  if (!value) {
    return undefined;
  }

  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  return items.length > 0 ? items : undefined;
}

export function loadSettingsFromEnv(): PtcSettings {
  const settings = {
    executionTimeoutMs: parsePositiveIntEnv(
      process.env.PTC_EXECUTION_TIMEOUT_MS,
      DEFAULT_EXECUTION_TIMEOUT_MS
    ),
    maxOutputChars: parsePositiveIntEnv(process.env.PTC_MAX_OUTPUT_CHARS, DEFAULT_MAX_OUTPUT_SIZE),
    allowMutations: parseBooleanEnv(process.env.PTC_ALLOW_MUTATIONS, false),
    allowBash: parseBooleanEnv(process.env.PTC_ALLOW_BASH, false),
    maxParallelToolCalls: parsePositiveIntEnv(
      process.env.PTC_MAX_PARALLEL_TOOL_CALLS,
      DEFAULT_MAX_PARALLEL_TOOL_CALLS
    ),
    useDocker: parseBooleanEnv(process.env.PTC_USE_DOCKER, false),
    allowUnsandboxedSubprocess: parseBooleanEnv(process.env.PTC_ALLOW_UNSANDBOXED_SUBPROCESS, false),
    debugLogging: parseBooleanEnv(process.env.PTC_DEBUG, false),
    autoRoute: parseBooleanEnv(process.env.PTC_AUTO_ROUTE, true),
    trustedReadOnlyTools: parseListEnv(process.env.PTC_TRUSTED_READ_ONLY_TOOLS),
    callableTools: parseListEnv(process.env.PTC_CALLABLE_TOOLS),
    blockedTools: parseListEnv(process.env.PTC_BLOCKED_TOOLS),
  } satisfies PtcSettings;

  debugLoggingEnabled = settings.debugLogging;
  return settings;
}

export function shouldAutoRoutePromptToCodeExecution(prompt: string): boolean {
  const normalized = prompt.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  if (/\b(?:use|call|run|invoke) (?:the )?code_execution\b/.test(normalized)) {
    return true;
  }

  const hasMutationIntent =
    /\b(edit|write|modify|change|update|fix|create|delete|rename|refactor|patch|implement|add|remove)\b/.test(
      normalized
    );
  if (hasMutationIntent) {
    return false;
  }

  const hasFanout =
    /(?:\*\*\/|\*\.[a-z0-9]+\b|\bglob\b|\bcodebase\b|\brepo\b|\brepository\b|\ball files\b|\bevery file\b|\bentire codebase\b|\bentire repo\b|\bacross (?:the )?(?:repo|codebase)\b|\bfirst \d+\b.*\bfiles?\b|\bmany files\b|\bmultiple files\b|\bfor each\b|\bfor every\b|\beach file\b)/.test(
      normalized
    );

  const hasProcessing =
    /\b(count|group|aggregate|rank|sort|top \d+|summari[sz]e|compare|statistics|histogram|frequency|frequencies|distribution|dedup|filter|tabulate)\b/.test(
      normalized
    );

  const hasContextPressure =
    /\b(compact json|json only|summary only|summaries only|keep intermediate|keep intermediates|stay out of chat|out of chat|without flooding|don't flood)\b/.test(
      normalized
    );

  return (hasFanout && (hasProcessing || hasContextPressure)) || (hasProcessing && hasContextPressure);
}

export function truncateOutput(output: string, maxOutputChars: number = DEFAULT_MAX_OUTPUT_SIZE): string {
  if (output.length <= maxOutputChars) {
    return output;
  }

  const truncated = output.substring(0, maxOutputChars);
  const truncationNotice = `\n\n[Output truncated - showing first ${maxOutputChars} characters of ${output.length}]`;
  return truncated + truncationNotice;
}

export function formatPythonError(message: string, traceback?: string): string {
  if (traceback) {
    return `Python execution error:\n${message}\n\nTraceback:\n${traceback}`;
  }
  return `Python execution error: ${message}`;
}

export function estimateTokensFromChars(chars: number): number {
  return Math.ceil(chars / 4);
}

export function validateUserCode(userCode: string): void {
  if (/\basyncio\.run\s*\(/.test(userCode)) {
    throw new Error(
      "Top-level await is already available inside code_execution. Remove asyncio.run(...) and await your coroutines directly."
    );
  }

  if (/\b_rpc_call\s*\(/.test(userCode)) {
    throw new Error(
      "Use the generated helper functions such as read(), glob(), find(), grep(), ls(), or ptc.read_many() instead of calling _rpc_call(...) directly."
    );
  }
}

function formatLogMessage(message: string, args: unknown[]): string {
  const suffix =
    args.length > 0
      ? ` ${args.map((arg) => formatWithOptions({ colors: false, depth: 4 }, arg)).join(" ")}`
      : "";
  return `${DEBUG_PREFIX} ${message}${suffix}`;
}

export function debugLog(message: string, ...args: unknown[]): void {
  if (debugLoggingEnabled) {
    process.stdout.write(`${formatLogMessage(message, args)}\n`);
  }
}

export function logWarning(message: string, ...args: unknown[]): void {
  process.emitWarning(formatLogMessage(message, args), { code: "PTC" });
}
