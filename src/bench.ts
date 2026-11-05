/**
 * Bug benchmark runner: reviews every case in benchmark/cases with a real
 * openreview.yml and scores the findings for precision and recall.
 *
 *   npm run build
 *   OPENCODE_API_KEY=... node dist-src/bench.js [--config .github/openreview.yml]
 *       [--cases benchmark/cases] [--only id1,id2] [--out run.json]
 *       [--report report.md] [--min-severity suggestion|medium|high] [--tolerance 3]
 *   node dist-src/bench.js --replay run.json     # re-score a saved run, no API calls
 *
 * Each case is reviewed the way main.ts reviews a PR (if_paths scoping, the
 * cross-file context block built from the case's after/ tree, dedupe and noise
 * controls), minus everything that talks to GitHub. Keys come from the env the
 * config's key_from names, exactly as in the action. Every run spends real
 * provider budget: one run per change worth measuring, not per commit.
 */
import { readFile, writeFile } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import * as YAML from "yaml";
import { parseConfig, type OpenReviewConfig } from "./config.js";
import { templateContextFor, resolveExtends, mergeConfigs, parseConfigLoose } from "./templates.js";
import { resolveKeysFromEnv, runAgentWithFallback, resolveDottedProvider, assertProviderRefs, type Finding, type AgentOutcome } from "./providers.js";
import { matchesAny, filterIgnored, dedupeFindings, resolveNoise, applyNoiseControls, splitDiff, scopeDiff } from "./reviewer.js";
import { buildContextBlock, buildRepoIndex } from "./context.js";
import { runPooled } from "./main.js";
import {
  parseCase, scoreCase, totals, renderReport, DEFAULT_SCORE_OPTIONS,
  type BenchCase, type CaseScore, type ScoreOptions, type Severity,
} from "./bench-score.js";

type AgentRecord = { review: string; agent: string; provider: string; outcome: AgentOutcome; seconds: number; error?: string };
type CaseRun = { id: string; findings: Finding[]; agents: AgentRecord[] };
type RunFile = { config: string; startedAt: string; cases: CaseRun[] };

async function loadConfig(path: string): Promise<OpenReviewConfig> {
  const raw = YAML.parse(await readFile(path, "utf8"));
  const loose = parseConfigLoose(raw);
  const entries = (loose.extends as string[] | undefined) ?? [];
  if (entries.length === 0) return parseConfig(raw);
  const { merged } = await resolveExtends(entries, templateContextFor(path, process.env as any));
  const { extends: _ignored, ...top } = loose;
  return parseConfig(mergeConfigs(merged, top) as unknown);
}

async function loadCases(dir: string, only: string[]): Promise<{ c: BenchCase; dir: string }[]> {
  if (!existsSync(dir)) throw new Error(`No cases directory at ${dir}`);
  const ids = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  const unknown = only.filter((id) => !ids.includes(id));
  if (unknown.length) throw new Error(`Unknown case(s): ${unknown.join(", ")}`);
  const out: { c: BenchCase; dir: string }[] = [];
  for (const id of ids) {
    if (only.length && !only.includes(id)) continue;
    const caseDir = join(dir, id);
    const c = parseCase(JSON.parse(await readFile(join(caseDir, "case.json"), "utf8")), `${id}/case.json`);
    out.push({ c, dir: caseDir });
  }
  return out;
}

async function reviewCase(config: OpenReviewConfig, caseDir: string, id: string, sessionId: string): Promise<CaseRun> {
  const diff = await readFile(join(caseDir, "patch.diff"), "utf8");
  const parsed = splitDiff(diff);
  const ignore = config.defaults.ignore ?? [];
  const inScope = filterIgnored(parsed.map((p) => p.file), ignore);
  const repoRoot = join(caseDir, "after");
  const repoIndex = buildRepoIndex(repoRoot, ignore);
  const keys = resolveKeysFromEnv(process.env as any);
  const deadlineAt = Date.now() + (config.defaults.max_runtime_s ?? 1200) * 1000;
  const findings: Finding[] = [];
  const agents: AgentRecord[] = [];
  for (const review of config.reviews) {
    const scopedFiles = inScope.filter((f) => matchesAny(f, review.if_paths));
    if (scopedFiles.length === 0) continue;
    const scopedDiff = scopeDiff(scopedFiles, parsed, inScope.length);
    const { block: contextBlock } = buildContextBlock({
      repoRoot,
      scopedFiles,
      contextFiles: review.context_files,
      includeFullFiles: review.include_full_files ?? config.defaults.include_full_files ?? true,
      maxContextChars: review.max_context_chars ?? config.defaults.max_context_chars ?? 20000,
      ignore,
    }, repoIndex);
    const defs = [
      { ...review.main, name: review.main.name ?? `${review.id}:main` },
      ...review.subagents.map((s, i) => ({ ...s, name: s.name ?? `${review.id}:sub${i}` })),
    ];
    const tasks = defs.map((a) => async (): Promise<{ findings: Finding[]; rec: AgentRecord }> => {
      const t0 = Date.now();
      try {
        const provider = config.providers[a.provider] ?? resolveDottedProvider(config.providers, a.provider).config;
        const r = await runAgentWithFallback({
          agentName: a.name, providerName: a.provider, provider, instructions: a.instructions,
          diff: scopedDiff, lang: config.defaults.lang ?? "en", keys,
          maxDiffChars: config.defaults.max_diff_chars ?? 80000, sessionId, contextBlock, deadlineAt,
        });
        return { findings: r.findings, rec: { review: review.id, agent: a.name, provider: a.provider, outcome: r.outcome, seconds: r.seconds } };
      } catch (e) {
        return {
          findings: [],
          rec: { review: review.id, agent: a.name, provider: a.provider, outcome: "error", seconds: (Date.now() - t0) / 1000, error: (e as Error).message },
        };
      }
    });
    const results = await runPooled(tasks, config.defaults.max_concurrency ?? 4);
    let fs = results.flatMap((r) => r.findings);
    if (review.verdict.deduplicate) fs = dedupeFindings(fs);
    fs = applyNoiseControls(fs, resolveNoise({
      profile: review.profile ?? config.defaults.profile,
      min_confidence: review.min_confidence ?? config.defaults.min_confidence,
      max_findings: review.max_findings ?? config.defaults.max_findings,
    })).visible;
    findings.push(...fs);
    agents.push(...results.map((r) => r.rec));
  }
  const ok = agents.filter((a) => a.outcome === "ok" || a.outcome === "no-findings").length;
  console.error(`${id}: ${findings.length} finding(s), ${ok}/${agents.length} agent(s) reviewed`);
  return { id, findings, agents };
}

function score(run: RunFile, cases: BenchCase[], opts: ScoreOptions): { report: string; incomplete: string[] } {
  const byId = new Map(run.cases.map((r) => [r.id, r]));
  const scores: CaseScore[] = [];
  const incomplete: string[] = [];
  for (const c of cases) {
    const r = byId.get(c.id);
    if (!r) continue;
    // A case where an agent failed was not fully reviewed: its misses say
    // nothing about the reviewer, so it is named instead of hidden in recall.
    const failed = r.agents.filter((a) => a.outcome !== "ok" && a.outcome !== "no-findings");
    if (failed.length) incomplete.push(`${c.id} (${failed.map((a) => `${a.agent}: ${a.outcome}`).join(", ")})`);
    scores.push(scoreCase(c, r.findings, opts));
  }
  const t = totals(scores);
  const notes = [
    `config ${run.config}, run ${run.startedAt}, min severity ${opts.minSeverity}, line tolerance ±${opts.tolerance}`,
    ...(incomplete.length ? [`⚠️ ${incomplete.length} case(s) not fully reviewed, so their misses may be agent failures: ${incomplete.join("; ")}`] : []),
  ];
  const fpDetail = scores.flatMap((s) => s.falsePositives.map((f) => `- \`${s.id}\` ${f.file}:${f.line ?? "?"} [${f.severity}] ${f.comment.replace(/\s+/g, " ").slice(0, 160)}`));
  const report = renderReport(scores, t, notes) + (fpDetail.length ? `\n\n<details><summary>False positives</summary>\n\n${fpDetail.join("\n")}\n</details>` : "");
  return { report, incomplete };
}

async function main() {
  const { values } = parseArgs({
    options: {
      config: { type: "string", default: ".github/openreview.yml" },
      cases: { type: "string", default: "benchmark/cases" },
      only: { type: "string" },
      out: { type: "string" },
      report: { type: "string" },
      replay: { type: "string" },
      "min-severity": { type: "string", default: DEFAULT_SCORE_OPTIONS.minSeverity },
      tolerance: { type: "string", default: String(DEFAULT_SCORE_OPTIONS.tolerance) },
    },
  });
  const minSeverity = values["min-severity"] as Severity;
  if (!["high", "medium", "suggestion"].includes(minSeverity)) throw new Error(`--min-severity must be high, medium or suggestion`);
  const tolerance = Number(values.tolerance);
  if (!Number.isInteger(tolerance) || tolerance < 0) throw new Error(`--tolerance must be a non-negative integer`);
  const only = values.only ? values.only.split(",").map((s) => s.trim()).filter(Boolean) : [];
  const cases = await loadCases(resolve(values.cases!), only);

  let run: RunFile;
  if (values.replay) {
    run = JSON.parse(await readFile(values.replay, "utf8"));
  } else {
    const config = await loadConfig(values.config!);
    assertProviderRefs(config);
    const sessionId = `bench-${Date.now()}`;
    run = { config: values.config!, startedAt: new Date().toISOString(), cases: [] };
    // Cases run one after another: each already fans out to max_concurrency
    // agents, and a parallel sweep would rate-limit small providers.
    for (const { c, dir } of cases) run.cases.push(await reviewCase(config, dir, c.id, sessionId));
    if (values.out) await writeFile(values.out, JSON.stringify(run, null, 2) + "\n");
    const reviewed = run.cases.some((r) => r.agents.some((a) => a.outcome === "ok" || a.outcome === "no-findings"));
    if (!reviewed) {
      const skipped = [...new Set(run.cases.flatMap((r) => r.agents.map((a) => `${a.provider}: ${a.outcome}`)))];
      throw new Error(`No agent reviewed any case (${skipped.join(", ") || "no agents ran"}). Set the env var each provider's key_from names.`);
    }
  }
  const { report } = score(run, cases.map((x) => x.c), { minSeverity, tolerance });
  if (values.report) await writeFile(values.report, report + "\n");
  console.log(report);
}

main().catch((e) => {
  console.error(`bench: ${(e as Error).message}`);
  process.exit(1);
});
