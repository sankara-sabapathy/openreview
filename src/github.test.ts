import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderStickyBody, STICKY_MARKER } from "./github.js";
import { countsAsReview, type AgentOutcome } from "./providers.js";

const base = { findings: [], runUrl: "https://example.test/run/1" };

describe("renderStickyBody (issue #46)", () => {
  it("a fully failed run says REVIEW FAILED, never approve or 'nice work'", () => {
    const body = renderStickyBody({
      ...base,
      verdict: "comment",
      status: "error",
      perReview: [{ id: "general-quality", verdict: "approve", count: 0, counted: false }],
      agents: [
        {
          review: "general-quality",
          agent: "general-quality:main",
          provider: "opencode",
          outcome: "error",
          seconds: 12,
        },
      ],
    });
    assert.match(body, /REVIEW FAILED/);
    assert.doesNotMatch(body, /APPROVE/);
    assert.doesNotMatch(body, /Nice work/);
    assert.match(body, /not reviewed/);
    assert.match(body, /No review completed/);
  });

  it("a partial run names the reviews that did not vote", () => {
    const body = renderStickyBody({
      ...base,
      verdict: "comment",
      status: "partial",
      perReview: [
        { id: "general-quality", verdict: "comment", count: 2, counted: true },
        { id: "security-strict", verdict: "approve", count: 0, counted: false },
      ],
      agents: [
        { review: "general-quality", agent: "main", provider: "opencode", outcome: "ok", seconds: 8 },
        {
          review: "security-strict",
          agent: "sec:main",
          provider: "codex",
          outcome: "skipped-no-key",
          seconds: 0,
        },
      ],
    });
    assert.match(body, /Partial review/);
    assert.match(body, /security-strict/);
    assert.match(body, /skipped \(no key\)/);
    assert.match(body, /APPROVE|REQUEST_CHANGES|COMMENT/);
  });

  it("a clean run still says nice work", () => {
    const body = renderStickyBody({
      ...base,
      verdict: "approve",
      status: "ok",
      perReview: [{ id: "general-quality", verdict: "approve", count: 0, counted: true }],
    });
    assert.match(body, /APPROVE/);
    assert.match(body, /Nice work/);
    assert.doesNotMatch(body, /REVIEW FAILED/);
  });

  it("always emits the sticky marker and the agent table", () => {
    const body = renderStickyBody({
      ...base,
      verdict: "comment",
      status: "ok",
      perReview: [{ id: "r", verdict: "comment", count: 0, counted: true }],
      agents: [{ review: "r", agent: "a", provider: "p", outcome: "ok", seconds: 1.25 }],
    });
    assert.ok(body.startsWith(STICKY_MARKER));
    assert.match(body, /<details><summary>🤖 1 agent\(s\)/);
    assert.match(body, /✅ reviewed/);
  });

  it("escapes pipes in comments and lists findings", () => {
    const body = renderStickyBody({
      ...base,
      verdict: "comment",
      status: "ok",
      perReview: [{ id: "r", verdict: "comment", count: 1, counted: true }],
      findings: [
        {
          file: "src/a.ts",
          line: 4,
          severity: "high",
          category: "bug",
          comment: "a | b | c",
          agent: "main",
          provider: "opencode",
        },
      ],
    });
    assert.match(body, /a \\\| b \\\| c/);
    assert.match(body, /`src\/a\.ts:4`/);
  });
});

describe("countsAsReview", () => {
  it("only ok / no-findings may vote", () => {
    const voting: AgentOutcome[] = ["ok", "no-findings"];
    // budget-exhausted must be here too: the dogfood review on #63 flagged that
  // it was missing from this list (it was already excluded by the function).
  const nonVoting: AgentOutcome[] = ["skipped-no-key", "budget-exhausted", "unparseable", "error"];
    for (const o of voting) assert.equal(countsAsReview(o), true, `${o} should vote`);
    for (const o of nonVoting) assert.equal(countsAsReview(o), false, `${o} must not vote`);
  });
});