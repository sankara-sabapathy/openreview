import * as core from "@actions/core";
import * as github from "@actions/github";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import * as YAML from "yaml";
import { parseConfig } from "./config.js";
import { templateContextFor, resolveExtends, mergeConfigs, parseConfigLoose } from "./templates.js";
import { resolveKeysFromEnv, runAgent, formatTokens, type Finding } from "./providers.js";
import {
  matchesAny, filterIgnored, dedupeFindings,
  decideReviewVerdict, combineVerdicts, combineBallots, resolveNoise, applyNoiseControls, type Verdict,
  satisfiesActionVersion, runningActionVersion,
} from "./reviewer.js";
import { renderStickyBody, upsertStickyComment, createInlineReview } from "./github.js";
import { initLogger, logInfo, logWarning, logDebug } from "./logger.js";
import { buildContextBlock } from "./context.js";

const CONFIG_CANDIDATES = [
  ".github/openreview.yml",
  ".github/openreview.yaml",
  "openreview.yml",
  "openreview.yaml",
];

async function loadConfig(configPath: string) {
  const candidates = [configPath, ...CONFIG_CANDIDATES.filter((c) => c !== configPath)];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    const raw = YAML.parse(await readFile(p, "utf8"));
    const loose = parseConfigLoose(raw);
    const extendsEntries = (loose.extends as string[] | undefined) ?? [];
    if (extendsEntries.length === 0) {
      return { config: parseConfig(raw), path: p };
    }
    // Templates resolve in order; this file overlays on top (child wins).
    const ctx = templateContextFor(p, process.env as any);
    const { merged, sources } = await resolveExtends(extendsEntries, ctx);
    const { extends: _ignored, ...top } = loose;
    const config = parseConfig(mergeConfigs(merged, top) as unknown);
    logInfo(
      `Resolved ${sources.length} template(s): ${sources
        .map((s) => (s.sha ? `${s.source} @${s.sha.slice(0, 7)}` : s.source))
        .join(", ")}`
    );
    return { config, path: p };
  }
  throw new Error(
    `No config found. Tried: ${candidates.join(", ")}. Add .github/openreview.yml (see openreview.example.yml).`
  );
}

async function getPrDiff(octokit: ReturnType<typeof github.getOctokit>, owner: string, repo: string, pr: number) {
  const { data: files } = await octokit.rest.pulls.listFiles({ owner, repo, pull_number: pr, per_page: 100 });
  const parts: string[] = [];
  const names: string[] = [];
  for (const f of files) {
    names.push(f.filename);
    if (f.patch) parts.push(`--- a/${f.filename}\n+++ b/${f.filename}\n${f.patch}`);
  }
  const { data: pull } = await octokit.rest.pulls.get({ owner, repo, pull_number: pr });
  return { fileNames: names, diff: parts.join("\n\n"), headSha: pull.head.sha };
}

export async function run(): Promise<void> {
  try {
    initLogger();
    const token = process.env["INPUT_GITHUB-TOKEN"] || process.env.GITHUB_TOKEN || "";
    if (!token) throw new Error("Missing github-token (GITHUB_TOKEN).");
    const octokit = github.getOctokit(token);
    const ctx = github.context;
    const issue = (ctx.payload as any).issue;
    const prNumber =
      ctx.payload.pull_request?.number ??
      (issue?.pull_request ? issue.number : undefined) ??
      Number(process.env.PR_NUMBER ?? 0);
    if (!prNumber) {
      logWarning("No pull_request context; nothing to review. (Supports pull_request + issue_comment /review)");
      return;
    }
    const { owner, repo } = ctx.repo;
    const configPath = core.getInput("config-path") || ".github/openreview.yml";
    const dryRun = (core.getInput("dry-run") || "false").toLowerCase() === "true";

    const { config, path } = await loadConfig(configPath);
    logInfo(`Loaded config: ${path} (${config.reviews.length} reviews)`);
    if (config.requires_action) {
      const running = runningActionVersion(process.env as any);
      if (running && !satisfiesActionVersion(config.requires_action, running)) {
        throw new Error(
          `This openreview.yml needs action ${config.requires_action} but the runner is ${running}. ` +
            `Bump the workflow ref (e.g. uses: sankara-sabapathy/openreview@v1) to a release satisfying the constraint.`
        );
      }
    }
    const keys = resolveKeysFromEnv(process.env as any);
    // Stable session per workflow run (required by OpenCode Go/Zen routing).
    const sessionId =
      process.env.GITHUB_RUN_ID ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    logInfo(`Reviewing PR #${prNumber} in ${owner}/${repo}`);
    const { fileNames, diff, headSha } = await getPrDiff(octokit, owner, repo, prNumber);
    logInfo(`Diff: ${fileNames.length} files, ${diff.length} chars (head ${headSha.slice(0, 7)})`);
    logDebug(`Diff files: ${fileNames.join(", ")}`);
    const inScope = filterIgnored(fileNames, config.defaults.ignore ?? []);
    if (!diff.trim() || inScope.length === 0) {
      logInfo("Empty diff or all files ignored.");
      return;
    }

    const perReview: {
      id: string;
      verdict: Verdict;
      findings: Finding[];
      errors: string[];
      usage: { agent: string; model: string; usage: { in: number; out: number }; seconds: number }[];
    }[] = [];
    for (const review of config.reviews) {
      const scopedFiles = inScope.filter((f) => matchesAny(f, review.if_paths));
      if (scopedFiles.length === 0) {
        logInfo(`Review ${review.id}: no matching paths, skipped.`);
        continue;
      }
      // Build a scoped diff (best-effort: filter diff hunks by filename header)
      const scopedDiff = scopedFiles.length === inScope.length ? diff : diff; // keep full diff; agents see file names
      // Cross-file context (issue #20): full files + call-site excerpts, budgeted.
      const { block: contextBlock } = buildContextBlock({
        repoRoot: process.cwd(),
        scopedFiles,
        contextFiles: review.context_files,
        includeFullFiles:
          review.include_full_files ?? config.defaults.include_full_files ?? true,
        maxContextChars:
          review.max_context_chars ?? config.defaults.max_context_chars ?? 20000,
        ignore: config.defaults.ignore ?? [],
      });
      const tasks: Promise<{
        findings: Finding[];
        usage: { in: number; out: number } | null;
        seconds: number;
        error?: string;
        agent: string;
        providerName: string;
      }>[] = [];
      const agentDefs = [
        { ...review.main, name: review.main.name ?? `${review.id}:main` },
        ...review.subagents.map((s, i) => ({ ...s, name: s.name ?? `${review.id}:sub${i}` })),
      ];
      logInfo(
        `Review ${review.id}: launching ${agentDefs.length} agent(s) [${agentDefs
          .map((a) => `${a.name}/${a.provider}`)
          .join(", ")}] on ${scopedFiles.length} file(s), strategy=${review.strategy}`
      );
      for (const a of agentDefs) {
        const provider = config.providers[a.provider];
        if (!provider) {
          logWarning(`Review ${review.id}: unknown provider '${a.provider}', skipped agent ${a.name}.`);
          continue;
        }
        tasks.push(
          runAgent({
            agentName: a.name ?? "agent",
            providerName: a.provider,
            provider,
            instructions: a.instructions,
            diff: scopedDiff,
            lang: config.defaults.lang ?? "en",
            keys,
            maxDiffChars: config.defaults.max_diff_chars ?? 80000,
            sessionId,
            contextBlock,
          })
            .then((result) => ({
              findings: result.findings,
              usage: result.usage,
              seconds: result.seconds,
              agent: a.name ?? "agent",
              providerName: a.provider,
            }))
            .catch((e) => {
              const msg = (e as Error).message;
              logWarning(`Agent ${a.name} failed: ${msg}`);
              return {
                findings: [] as Finding[],
                usage: null,
                seconds: 0,
                error: msg,
                agent: a.name ?? "agent",
                providerName: a.provider,
              };
            })
        );
      }
      const results = await Promise.all(tasks);
      let findings = results.flatMap((r) => r.findings);
      const agentErrors = results.filter((r) => r.error).map((r) => `- \`${r.agent}\`: ${r.error}`);
      if (review.verdict.deduplicate) findings = dedupeFindings(findings);
      // Noise controls (issue #21): confidence floor + cap, then verdict on survivors.
      const noise = resolveNoise({
        profile: review.profile ?? config.defaults.profile,
        min_confidence: review.min_confidence ?? config.defaults.min_confidence,
        max_findings: review.max_findings ?? config.defaults.max_findings,
      });
      const preNoise = findings.length;
      findings = applyNoiseControls(findings, noise).visible;
      if (findings.length < preNoise) {
        logInfo(
          `Review ${review.id}: noise controls dropped ${preNoise - findings.length} finding(s) ` +
            `(profile=${review.profile ?? config.defaults.profile}, min_confidence=${noise.min_confidence}, max_findings=${noise.max_findings})`
        );
      }
      findings.sort((a, b) =>
        ({ high: 0, medium: 1, suggestion: 2 } as const)[a.severity] -
        ({ high: 0, medium: 1, suggestion: 2 } as const)[b.severity]
      );
      const verdict = (() => {
        // One ballot per distinct provider (issue #12). `any` reproduces the
        // old pooled behavior exactly; `all`/`majority` resolve disagreement.
        const byProvider = new Map<string, typeof findings>();
        for (const f of findings) {
          const list = byProvider.get(f.provider) ?? [];
          list.push(f);
          byProvider.set(f.provider, list);
        }
        const ballots = [...byProvider.entries()].map(([name, fs]) => {
          const v = decideReviewVerdict(review.verdict.mode, review.verdict.min_severity, fs);
          logInfo(`Review ${review.id}: ballot ${name} -> ${v} (${fs.length} findings)`);
          return v;
        });
        return combineBallots(ballots, review.strategy);
      })();
      perReview.push({
        id: review.id,
        verdict,
        findings,
        errors: agentErrors,
        usage: results
          .filter((r) => r.usage)
          .map((r) => ({
            agent: r.agent,
            model: config.providers[r.providerName]?.model ?? r.providerName,
            usage: r.usage as { in: number; out: number },
            seconds: r.seconds,
          })),
      });
      logInfo(`Review ${review.id}: ${findings.length} findings -> ${verdict}`);
    }

    const global = combineVerdicts(
      perReview.map((r) => r.verdict),
      config.global_verdict.strategy
    );
    const all = perReview.flatMap((r) => r.findings);
    core.setOutput("verdict", global);

    const runUrl = `${process.env.GITHUB_SERVER_URL ?? "https://github.com"}/${owner}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID ?? ""}`;
    const stickyBase = renderStickyBody({
      verdict: global,
      perReview: perReview.map((r) => ({ id: r.id, verdict: r.verdict, count: r.findings.length })),
      findings: all,
      runUrl,
    });
    const hasAnyKey = Boolean(keys.anthropicApiKey || keys.openaiApiKey || keys.opencodeApiKey);
    const allErrors = perReview.flatMap((r) => r.errors);
    // Consolidated usage, grouped by model: "model 12.3k/1.1k 38t/s".
    const usageByModel = new Map<string, { In: number; Out: number; seconds: number }>();
    for (const r of perReview) {
      for (const u of r.usage) {
        const e = usageByModel.get(u.model) ?? { In: 0, Out: 0, seconds: 0 };
        e.In += u.usage.in;
        e.Out += u.usage.out;
        e.seconds += u.seconds;
        usageByModel.set(u.model, e);
      }
    }
    const usageLine = [...usageByModel.entries()]
      .map(
        ([m, e]) =>
          `${m} ${formatTokens(e.In)}/${formatTokens(e.Out)}` +
          (e.Out > 0 && e.seconds > 0 ? ` ${(e.Out / e.seconds).toFixed(0)}t/s` : "")
      )
      .join(" · ");
    let sticky = stickyBase;
    if (usageLine) {
      sticky += `\n<sub>Models: ${usageLine}</sub>`;
      logInfo(`Usage: ${usageLine}`);
    }
    if (!hasAnyKey) {
      sticky += `\n\n> ⚠️ No provider API keys configured — agents were skipped. Add \`ANTHROPIC_API_KEY\`, \`OPENAI_API_KEY\`, or \`OPENCODE_API_KEY\` as repo Actions secrets (only the ones your \`providers{}\` use).`;
    } else if (all.length === 0 && allErrors.length > 0) {
      sticky += `\n\n<details><summary>⚠️ All agents failed — details</summary>\n\n${allErrors.join("\n")}\n\nCheck model IDs and base URLs against provider docs.</details>`;
    }

    if (dryRun) {
      logInfo(`DRY RUN verdict=${global}\n${sticky.slice(0, 2000)}`);
      return;
    }
    if (config.global_verdict.sticky_comment) {
      await upsertStickyComment(octokit, owner, repo, prNumber, sticky);
      logInfo(`Published sticky comment (verdict ${global}, ${all.length} findings).`);
    }
    const wantInline = perReview.some((r) => r.findings.length > 0);
    if (wantInline) {
      try {
        await createInlineReview(octokit, owner, repo, prNumber, headSha, global, all);
        logInfo(`Published inline review (${global}).`);
      } catch (e) {
        logWarning(`Inline review failed (non-fatal): ${(e as Error).message}`);
      }
    }
    if (global === "request_changes" && config.global_verdict.fail_check_on_request_changes)
      core.setFailed("OpenReview verdict: request_changes");
  } catch (e) {
    core.setFailed((e as Error).message);
  }
}
