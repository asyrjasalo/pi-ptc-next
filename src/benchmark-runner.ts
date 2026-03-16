import fs from "node:fs";
import path from "node:path";
import { parseEvalCase, type EvalCase } from "./eval-cases";
import type { RecoveryFailureClass } from "./recovery-state";
import { estimateTokensFromChars, shouldAutoRoutePromptToCodeExecution } from "./utils";

export const BENCHMARK_OBSERVED_FIRST_PATHS = ["code_execution", "direct", "none"] as const;

export type BenchmarkObservedFirstPath = (typeof BENCHMARK_OBSERVED_FIRST_PATHS)[number];

export interface BenchmarkResult {
  case_id: string;
  provider: string;
  model: string;
  expected_first_path: EvalCase["expected_first_path"];
  observed_first_path: BenchmarkObservedFirstPath;
  success: boolean;
  recovery_attempted: boolean;
  failure_class: RecoveryFailureClass | null;
  total_tokens: number;
  duration_ms: number;
}

export interface BenchmarkRuleOutcome {
  rule: string;
  passed: boolean;
}

export interface BenchmarkResultRecord {
  result: BenchmarkResult;
  rule_outcomes: BenchmarkRuleOutcome[];
}

export interface BenchmarkRunSummary {
  total_cases: number;
  successful_cases: number;
  routed_cases: number;
  recovery_attempts: number;
}

export interface BenchmarkRegression {
  case_id: string;
  kind: "routing" | "recovery" | "success";
  message: string;
}

export interface BenchmarkComparison {
  baseline_path: string;
  regressions: BenchmarkRegression[];
}

export interface BenchmarkRun {
  provider: string;
  model: string;
  generated_at: string;
  results: BenchmarkResultRecord[];
  summary: BenchmarkRunSummary;
  comparison?: BenchmarkComparison;
}

export interface BenchmarkObservation {
  observed_first_path?: BenchmarkObservedFirstPath;
  success?: boolean;
  recovery_attempted?: boolean;
  failure_class?: RecoveryFailureClass | null;
  total_tokens?: number;
  duration_ms?: number;
  output?: string;
}

export interface BenchmarkExecutionContext {
  provider: string;
  model: string;
}

export type BenchmarkCaseExecutor = (
  evalCase: EvalCase,
  context: BenchmarkExecutionContext
) => Promise<BenchmarkObservation> | BenchmarkObservation;

export interface BenchmarkRunOptions {
  provider: string;
  model: string;
  evalsPath?: string;
  caseIds?: string[];
  baselinePath?: string;
  timestamp?: string;
  executor?: BenchmarkCaseExecutor;
}

interface RuleExpectation {
  key: string;
  value: string;
}

function parseRuleExpectation(rule: string): RuleExpectation | null {
  const equalsIndex = rule.indexOf("=");
  if (equalsIndex === -1) {
    return null;
  }

  const key = rule.slice(0, equalsIndex).trim();
  const value = rule.slice(equalsIndex + 1).trim();

  if (!key || !value) {
    return null;
  }

  return { key, value };
}

function getRuleExpectation(rules: string[], key: string): string | undefined {
  for (const rule of rules) {
    const parsed = parseRuleExpectation(rule);
    if (parsed?.key === key) {
      return parsed.value;
    }
  }

  return undefined;
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  return undefined;
}

function parseFailureClass(value: string | undefined): RecoveryFailureClass | null {
  if (value === "missing-await" || value === "async-wrapper-iterated") {
    return value;
  }

  return null;
}

export function resolveBenchmarkEvalsPath(cwd: string = process.cwd(), evalsPath: string = process.env.PTC_EVALS_PATH || ".pi/evals/ptc"): string {
  return path.resolve(cwd, evalsPath);
}

export function getProviderModelSlug(provider: string, model: string): string {
  const normalize = (value: string) => {
    const slug = value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
    return slug || "unknown";
  };

  return `${normalize(provider)}__${normalize(model)}`;
}

export function getDefaultBenchmarkResultPath(evalsPath: string, provider: string, model: string, timestamp: string): string {
  return path.join(evalsPath, "results", getProviderModelSlug(provider, model), `${timestamp}.json`);
}

export function getDefaultBenchmarkBaselinePath(evalsPath: string, provider: string, model: string): string {
  return path.join(evalsPath, "baselines", `${getProviderModelSlug(provider, model)}.json`);
}

export function loadEvalCasesFromDisk(evalsPath: string, caseIds?: string[]): EvalCase[] {
  const casesDir = path.join(evalsPath, "cases");
  const fileNames = fs
    .readdirSync(casesDir)
    .filter((entry) => entry.endsWith(".json"))
    .sort();
  const selectedCaseIds = caseIds && caseIds.length > 0 ? new Set(caseIds) : null;

  const cases = fileNames.map((fileName) => {
    const filePath = path.join(casesDir, fileName);
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    return parseEvalCase(parsed, fileName);
  });

  if (!selectedCaseIds) {
    return cases;
  }

  return cases.filter((evalCase) => selectedCaseIds.has(evalCase.id));
}

export function createDeterministicBenchmarkExecutor(): BenchmarkCaseExecutor {
  return (evalCase, context) => {
    const observed_first_path: BenchmarkObservedFirstPath = shouldAutoRoutePromptToCodeExecution(evalCase.prompt)
      ? "code_execution"
      : "direct";
    const recoveryExpected = parseBoolean(getRuleExpectation(evalCase.acceptance.rules, "recovery_attempted")) === true;
    const failureClass = parseFailureClass(getRuleExpectation(evalCase.acceptance.rules, "failure_class"));
    const wantsJson = parseBoolean(getRuleExpectation(evalCase.acceptance.rules, "output_json")) === true;
    const recovery_attempted = observed_first_path === "code_execution" && recoveryExpected;
    const output = wantsJson
      ? JSON.stringify({ case_id: evalCase.id, provider: context.provider, model: context.model })
      : `completed:${evalCase.id}`;
    const total_tokens = estimateTokensFromChars(
      evalCase.prompt.length + output.length + context.provider.length + context.model.length
    );
    const duration_ms = evalCase.prompt.length + evalCase.id.length;

    return {
      observed_first_path,
      recovery_attempted,
      failure_class: recovery_attempted ? failureClass : null,
      total_tokens,
      duration_ms,
      output,
    } satisfies BenchmarkObservation;
  };
}

function evaluateRule(rule: string, record: BenchmarkResult, output: string | undefined): boolean {
  const expectation = parseRuleExpectation(rule);
  if (!expectation) {
    return false;
  }

  switch (expectation.key) {
    case "observed_first_path":
      return record.observed_first_path === expectation.value;
    case "success": {
      const expected = parseBoolean(expectation.value);
      return expected !== undefined && record.success === expected;
    }
    case "recovery_attempted": {
      const expected = parseBoolean(expectation.value);
      return expected !== undefined && record.recovery_attempted === expected;
    }
    case "failure_class":
      return (record.failure_class ?? "null") === expectation.value;
    case "output_json": {
      const expected = parseBoolean(expectation.value);
      if (expected === false) {
        return false;
      }

      if (expected !== true || typeof output !== "string") {
        return false;
      }

      try {
        JSON.parse(output);
        return true;
      } catch {
        return false;
      }
    }
    default:
      return false;
  }
}

export function buildBenchmarkResultRecord(
  evalCase: EvalCase,
  provider: string,
  model: string,
  observation: BenchmarkObservation
): BenchmarkResultRecord {
  const baseResult: BenchmarkResult = {
    case_id: evalCase.id,
    provider,
    model,
    expected_first_path: evalCase.expected_first_path,
    observed_first_path: observation.observed_first_path ?? "none",
    success: false,
    recovery_attempted: observation.recovery_attempted ?? false,
    failure_class: observation.failure_class ?? null,
    total_tokens: observation.total_tokens ?? 0,
    duration_ms: observation.duration_ms ?? 0,
  };

  const nonSuccessRules = evalCase.acceptance.rules.filter((rule) => !rule.startsWith("success="));
  const passesNonSuccessRules = nonSuccessRules.every((rule) => evaluateRule(rule, baseResult, observation.output));
  const result: BenchmarkResult = {
    ...baseResult,
    success: observation.success ?? passesNonSuccessRules,
  };
  const rule_outcomes = evalCase.acceptance.rules.map((rule) => ({
    rule,
    passed: evaluateRule(rule, result, observation.output),
  }));

  return { result, rule_outcomes };
}

function buildBenchmarkSummary(records: BenchmarkResultRecord[]): BenchmarkRunSummary {
  return {
    total_cases: records.length,
    successful_cases: records.filter((record) => record.result.success).length,
    routed_cases: records.filter((record) => record.result.observed_first_path === "code_execution").length,
    recovery_attempts: records.filter((record) => record.result.recovery_attempted).length,
  };
}

export function readBenchmarkRun(filePath: string): BenchmarkRun {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as BenchmarkRun;
}

export function compareBenchmarkRuns(current: BenchmarkRun, baseline: BenchmarkRun, baselinePath: string): BenchmarkComparison {
  const regressions: BenchmarkRegression[] = [];
  const baselineByCaseId = new Map(baseline.results.map((record) => [record.result.case_id, record.result]));

  for (const record of current.results) {
    const currentResult = record.result;
    const baselineResult = baselineByCaseId.get(currentResult.case_id);
    if (!baselineResult) {
      continue;
    }

    if (
      baselineResult.observed_first_path === baselineResult.expected_first_path &&
      currentResult.observed_first_path !== currentResult.expected_first_path
    ) {
      regressions.push({
        case_id: currentResult.case_id,
        kind: "routing",
        message: `routing regressed from ${baselineResult.observed_first_path} to ${currentResult.observed_first_path}`,
      });
    }

    if (baselineResult.recovery_attempted && !currentResult.recovery_attempted) {
      regressions.push({
        case_id: currentResult.case_id,
        kind: "recovery",
        message: "recovery no longer triggers for a previously recovered case",
      });
    }

    if (baselineResult.failure_class && baselineResult.failure_class !== currentResult.failure_class) {
      regressions.push({
        case_id: currentResult.case_id,
        kind: "recovery",
        message: `failure class regressed from ${baselineResult.failure_class} to ${currentResult.failure_class ?? "null"}`,
      });
    }

    if (baselineResult.success && !currentResult.success) {
      regressions.push({
        case_id: currentResult.case_id,
        kind: "success",
        message: "case no longer satisfies acceptance rules",
      });
    }
  }

  return {
    baseline_path: baselinePath,
    regressions,
  };
}

export async function runBenchmarkSuite(options: BenchmarkRunOptions): Promise<BenchmarkRun> {
  const evalsPath = resolveBenchmarkEvalsPath(process.cwd(), options.evalsPath);
  const executor = options.executor ?? createDeterministicBenchmarkExecutor();
  const context = { provider: options.provider, model: options.model };
  const evalCases = loadEvalCasesFromDisk(evalsPath, options.caseIds);
  const results: BenchmarkResultRecord[] = [];

  for (const evalCase of evalCases) {
    const observation = await executor(evalCase, context);
    results.push(buildBenchmarkResultRecord(evalCase, options.provider, options.model, observation));
  }

  const run: BenchmarkRun = {
    provider: options.provider,
    model: options.model,
    generated_at: options.timestamp ?? new Date().toISOString(),
    results,
    summary: buildBenchmarkSummary(results),
  };

  if (options.baselinePath) {
    const baseline = readBenchmarkRun(options.baselinePath);
    run.comparison = compareBenchmarkRuns(run, baseline, options.baselinePath);
  }

  return run;
}

export function writeBenchmarkRun(filePath: string, run: BenchmarkRun): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(run, null, 2)}\n`, "utf8");
}

interface ParsedCliArgs {
  provider: string;
  model: string;
  evalsPath?: string;
  baselinePath?: string;
  resultsPath?: string;
  caseIds?: string[];
  timestamp?: string;
}

function parseCliArgs(argv: string[]): ParsedCliArgs {
  const parsed: ParsedCliArgs = {
    provider: "local",
    model: "deterministic",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    switch (arg) {
      case "--provider":
        parsed.provider = next;
        index += 1;
        break;
      case "--model":
        parsed.model = next;
        index += 1;
        break;
      case "--evals-path":
        parsed.evalsPath = next;
        index += 1;
        break;
      case "--baseline":
        parsed.baselinePath = next;
        index += 1;
        break;
      case "--results-path":
        parsed.resultsPath = next;
        index += 1;
        break;
      case "--cases":
        parsed.caseIds = next
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean);
        index += 1;
        break;
      case "--timestamp":
        parsed.timestamp = next;
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return parsed;
}

export async function runBenchmarkCli(argv: string[] = process.argv.slice(2)): Promise<BenchmarkRun> {
  const parsed = parseCliArgs(argv);
  const evalsPath = resolveBenchmarkEvalsPath(process.cwd(), parsed.evalsPath);
  const run = await runBenchmarkSuite({
    provider: parsed.provider,
    model: parsed.model,
    evalsPath,
    caseIds: parsed.caseIds,
    baselinePath: parsed.baselinePath,
    timestamp: parsed.timestamp,
  });
  const resultsPath = parsed.resultsPath ?? getDefaultBenchmarkResultPath(evalsPath, run.provider, run.model, run.generated_at);

  writeBenchmarkRun(resultsPath, run);
  process.stdout.write(`${JSON.stringify({ results_path: resultsPath, summary: run.summary, comparison: run.comparison ?? null })}\n`);
  return run;
}
