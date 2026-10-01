import * as github from "@actions/github";

export const STICKY_MARKER = "<!-- openreview:sticky -->";
export const LOGO_URL =
  "https://raw.githubusercontent.com/sankara-sabapathy/openreview/v1/assets/logo.svg";

export function renderStickyBody(opts: {
  verdict: string;
  perReview: { id: string; verdict: string; count: number }[];
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
  const lines: string[] = [];
  lines.push(STICKY_MARKER);
  lines.push(
    `<img src="${LOGO_URL}" width="28" height="28" align="left" alt="OpenReview AI" />`
  );
  lines.push(`## OpenReview AI — ${opts.verdict.replace(/_/g, " ").toUpperCase()}`);
  lines.push("");
  lines.push("<br />");
  lines.push("");
  for (const r of opts.perReview)
    lines.push(`- \`${r.id}\`: **${r.verdict}** (${r.count} findings)`);
  lines.push("");
  if (opts.findings.length === 0) {
    lines.push("No actionable findings. Nice work.");
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
    body: `<img src="${LOGO_URL}" width="20" height="20" alt="OpenReview AI" /> **OpenReview AI:** ${verdict} (${findings.length} findings)`,
    comments: comments as any,
  });
}
