import * as github from "@actions/github";

export const STICKY_MARKER = "<!-- openreview:sticky -->";

function actionBase(): { repo: string; ref: string } {
  // Prefer the action's own coordinates so forks/renames keep working; the
  // hardcoded default matches this repo's published location.
  const repo = process.env.GITHUB_ACTION_REPOSITORY || "sankara-sabapathy/openreview";
  const ref = process.env.GITHUB_ACTION_REF || "";
  // With `uses: ./` (how PRs dogfood unreleased changes) GITHUB_ACTION_REF is the
  // checkout ref — `refs/pull/62/merge` — which raw.githubusercontent cannot
  // serve, so the logo would 404 in every comment. Prefer the PR's head branch,
  // then any plain branch/tag, and fall back to the default branch.
  const head = process.env.GITHUB_HEAD_REF || "";
  if (head && !head.includes("..") && !/[~^:\\]|\s/.test(head)) return { repo, ref: head };
  if (/^[\w.\-/]+$/.test(ref) && !ref.startsWith("refs/")) return { repo, ref };
  return { repo, ref: "main" };
}

export function logoUrl(): string {
  const { repo, ref } = actionBase();
  return `https://raw.githubusercontent.com/${repo}/${ref}/assets/logo.svg`;
}

export type RunStatus = "ok" | "partial" | "error";

const OUTCOME_LABEL: Record<string, string> = {
  ok: "✅ reviewed",
  "no-findings": "✅ no findings",
  "skipped-no-key": "⏭️ skipped (no key)",
  unparseable: "⚠️ unusable response",
  error: "❌ failed",
};

export function renderStickyBody(opts: {
  verdict: string;
  status?: RunStatus;
  perReview: { id: string; verdict: string; count: number; counted?: boolean }[];
  agents?: {
    review: string;
    agent: string;
    provider: string;
    outcome: string;
    seconds: number;
  }[];
  findings: {
    file: string;
    line?: number;
    severity: string;
    category: string;
    comment: string;
    agent: string;
    provider: string;
  }[];
  runUrl?: string;
}): string {
  const status = opts.status ?? "ok";
  const lines: string[] = [];
  lines.push(STICKY_MARKER);
  lines.push(
    `<img src="${logoUrl()}" width="28" height="28" align="left" alt="OpenReview AI" />`
  );
  // Fail loud: a run where nothing was reviewed must never read as a pass
  // (issue #46). "APPROVE / No actionable findings. Nice work." was printed for
  // runs where every agent had errored.
  lines.push(
    status === "error"
      ? `## OpenReview AI — REVIEW FAILED`
      : `## OpenReview AI — ${opts.verdict.replace(/_/g, " ").toUpperCase()}`
  );
  lines.push("");
  lines.push("<br />");
  lines.push("");
  if (status === "partial") {
    const failed = opts.perReview.filter((r) => r.counted === false).map((r) => r.id);
    lines.push(
      `> ⚠️ **Partial review** — ${failed.map((i) => `\`${i}\``).join(", ")} produced no usable result and did not vote.`
    );
    lines.push("");
  }
  for (const r of opts.perReview)
    lines.push(
      `- \`${r.id}\`: **${r.counted === false ? "not reviewed" : r.verdict}** (${r.count} findings)`
    );
  lines.push("");
  if (status === "error") {
    lines.push("**No review completed.** The verdict below is not a pass — see the agent results.");
    lines.push("");
  }
  if (opts.findings.length === 0) {
    lines.push(
      status === "ok"
        ? "No actionable findings. Nice work."
        : "No findings were produced (the run did not complete cleanly)."
    );
  } else {
    lines.push("| Severity | File | Finding | Agent |");
    lines.push("|---|---|---|---|");
    for (const f of opts.findings.slice(0, 50)) {
      const loc = f.line ? `${f.file}:${f.line}` : f.file;
      const one = f.comment.replace(/\n+/g, " ").replace(/\|/g, "\\|").slice(0, 220);
      lines.push(`| ${f.severity} | \`${loc}\` | ${one} | ${f.agent}/${f.provider} |`);
    }
    if (opts.findings.length > 50)
      lines.push(`\n… and ${opts.findings.length - 50} more (see inline comments).`);
  }
  const agents = opts.agents ?? [];
  const rough = agents.filter((a) => a.outcome !== "ok" && a.outcome !== "no-findings");
  if (agents.length > 0) {
    lines.push("");
    lines.push(
      `<details><summary>🤖 ${agents.length} agent(s)${rough.length ? ` — ${rough.length} not clean` : ""}</summary>`
    );
    lines.push("");
    lines.push("| Agent | Provider | Outcome | Time |");
    lines.push("|---|---|---|---|");
    for (const a of agents) {
      lines.push(
        `| ${a.agent} | ${a.provider} | ${OUTCOME_LABEL[a.outcome] ?? a.outcome} | ${a.seconds.toFixed(1)}s |`
      );
    }
    lines.push("");
    lines.push("</details>");
  }
  if (opts.runUrl) lines.push(`\n<sub>Run: ${opts.runUrl}</sub>`);
  lines.push(`\n<sub>Re-review with \`/review\`. Config: \`.github/openreview.yml\`.</sub>`);
  return lines.join("\n");
}

export async function upsertStickyComment(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  issueNumber: number,
  body: string
): Promise<void> {
  const { data: comments } = await octokit.rest.issues.listComments({
    owner, repo, issue_number: issueNumber, per_page: 100,
  });
  const prev = comments.find((c) => c.body?.includes(STICKY_MARKER));
  if (prev) {
    await octokit.rest.issues.updateComment({ owner, repo, comment_id: prev.id, body });
  } else {
    await octokit.rest.issues.createComment({ owner, repo, issue_number: issueNumber, body });
  }
}

export async function createInlineReview(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  pullNumber: number,
  commitSha: string,
  verdict: "approve" | "comment" | "request_changes",
  findings: { file: string; line?: number; comment: string }[]
): Promise<void> {
  const event = verdict === "approve" ? "APPROVE" : verdict === "request_changes" ? "REQUEST_CHANGES" : "COMMENT";
  const comments = findings
    .filter((f) => f.line && f.line > 0)
    .slice(0, 20)
    .map((f) => ({ path: f.file, line: f.line as number, body: f.comment }));
  await octokit.rest.pulls.createReview({
    owner, repo, pull_number: pullNumber, commit_id: commitSha, event: event as any,
    body: `<img src="${logoUrl()}" width="20" height="20" alt="OpenReview AI" /> **OpenReview AI:** ${verdict} (${findings.length} findings)`,
    comments: comments as any,
  });
}
