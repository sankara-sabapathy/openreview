import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  combineVerdicts,
  combineBallots,
  decideReviewVerdict,
  matchGlob,
  matchesAny,
  filterIgnored,
  applyNoiseControls,
  resolveNoise,
  satisfiesActionVersion,
  applyDegradedFloor,
  splitDiff,
  scopeDiff,
  parseHunkRanges,
  lineInRanges,
  applySuppression,
} from "./reviewer.js";

type V = "approve" | "comment" | "request_changes";
const RANK: Record<V, number> = { approve: 0, comment: 1, request_changes: 2 };

/** Exhaustive matrix: 3^n verdict sets, every strategy, both orderings. */
function allVerdictSets(n: number): V[][] {
  const out: V[][] = [];
  const walk = (acc: V[]) => {
    if (acc.length === n) {
      out.push([...acc]);
      return;
    }
    for (const v of ["approve", "comment", "request_changes"] as V[]) walk([...acc, v]);
  };
  walk([]);
  return out;
}

describe("combineVerdicts (issue #45)", () => {
  const strategies = ["any_blocking", "max_severity", "majority"] as const;

  for (const strategy of strategies) {
    it(`${strategy}: is order-independent and matches the documented rule`, () => {
      for (const n of [1, 2, 3, 4, 5]) {
        for (const set of allVerdictSets(n)) {
          const v = combineVerdicts(set, strategy);
          const approvals = set.filter((x) => x === "approve").length;
          const worst = set.reduce((a, b) => (RANK[b] > RANK[a] ? b : a));

          if (strategy === "majority") {
            // approve iff a quorum of approvals; otherwise the worst verdict.
            const expected = approvals * 2 > set.length ? "approve" : worst;
            assert.equal(v, expected, `majority ${JSON.stringify(set)} -> ${v}, want ${expected}`);
          } else {
            // any_blocking / max_severity: the most severe verdict always wins.
            assert.equal(v, worst, `${strategy} ${JSON.stringify(set)} -> ${v}, want ${worst}`);
          }
          // Order independence (the old majority rule depended on Map order).
          assert.equal(
            combineVerdicts([...set].reverse(), strategy),
            v,
            `${strategy} ${JSON.stringify(set)} is order-dependent`
          );
        }
      }
    });

    it(`${strategy}: a request_changes needs a real quorum of approvals to lose`, () => {
      for (const set of allVerdictSets(4)) {
        const v = combineVerdicts(set, strategy);
        const approvals = set.filter((x) => x === "approve").length;
        if (set.includes("request_changes") && approvals * 2 <= set.length) {
          assert.equal(
            v,
            "request_changes",
            `${JSON.stringify(set)} -> ${v}: approvals=${approvals} is not a majority`
          );
        }
      }
    });
  }

  it("reproduces the reported bug", () => {
    // These three returned `approve` before the fix.
    assert.equal(
      combineVerdicts(["approve", "comment", "request_changes"], "majority"),
      "request_changes"
    );
    assert.equal(combineVerdicts(["approve", "approve", "request_changes"], "majority"), "approve");
    assert.equal(combineVerdicts(["approve", "comment"], "majority"), "comment");
    assert.equal(combineVerdicts(["comment", "approve"], "majority"), "comment");
  });

  it("majority does outvote a lone blocker once approvals form a quorum", () => {
    // This is the documented meaning of opting into `majority` (flagged by the
    // dogfood review on #62 as a comment/reality mismatch) — pinned so the
    // wording in the doc comment cannot drift again.
    assert.equal(
      combineVerdicts(["approve", "approve", "approve", "request_changes"], "majority"),
      "approve"
    );
    // …but a lone blocker survives whenever approvals are NOT a quorum.
    assert.equal(
      combineVerdicts(["approve", "approve", "request_changes"], "majority"),
      "approve" // 2 of 3 is still a quorum
    );
    assert.equal(
      combineVerdicts(["approve", "comment", "request_changes"], "majority"),
      "request_changes"
    );
    assert.equal(combineVerdicts(["approve", "request_changes"], "majority"), "request_changes");
  });

  it("an empty set is never approve (fail-closed for a fully failed run)", () => {
    for (const strategy of strategies) {
      assert.equal(combineVerdicts([], strategy), "comment");
    }
  });
});

describe("matchGlob (issue #48)", () => {
  const cases: [path: string, pattern: string, expected: boolean][] = [
    // **/*.ext must match root-level AND nested (the bug).
    ["main.ts", "**/*.ts", true],
    ["src/a.ts", "**/*.ts", true],
    ["src/deep/nested/a.ts", "**/*.ts", true],
    ["a.js", "**/*.js", true],
    ["src/a.js", "**/*.js", true],
    ["src/a.jsx", "**/*.js", false],
    // **/ alone and trailing /** still behave.
    ["src/a/b.ts", "**", true],
    ["a.ts", "**/**", true],
    ["src/a.ts", "src/**", true],
    ["src/a/b/c.ts", "src/**", true],
    ["other/a.ts", "src/**", false],
    ["src/test.ts", "src/**/test.ts", true],
    ["src/a/test.ts", "src/**/test.ts", true],
    ["src/a/b/test.ts", "src/**/test.ts", true],
    ["src/test.tsx", "src/**/test.ts", false],
    // single * stays in one segment.
    ["a.ts", "*.ts", true],
    ["foo.tsx", "*.ts", false],
    ["src/a.ts", "*.ts", false],
    ["src/a.ts", "src/*.ts", true],
    ["src/deep/a.ts", "src/*.ts", false],
    // legacy in-segment ** keeps crossing directories (back-compat).
    ["x.lock", "**.lock", true],
    ["sub/dir/x.lock", "**.lock", true],
    ["src/x.lockfile", "**.lock", false],
    // prefix must not over-match.
    ["dist/x/y.js", "dist/**", true],
    ["distributor/x.js", "dist/**", false],
    ["distribution", "dist", false],
    // exact paths and dots.
    ["src", "src", true],
    ["src/a.ts", "src", false],
    ["src/providers.ts", "src/providers.ts", true],
  ];

  for (const [path, pattern, expected] of cases) {
    it(`${pattern} ${expected ? "matches" : "does not match"} ${path}`, () => {
      assert.equal(matchGlob(path, pattern), expected);
    });
  }

  it("treats regex metacharacters in patterns as literals", () => {
    assert.equal(matchGlob("a+b.ts", "a+b.ts"), true);
    assert.equal(matchGlob("axb.ts", "a+b.ts"), false);
    assert.equal(matchGlob("v1.2.3.txt", "v1.2.3.txt"), true);
    assert.equal(matchGlob("v1x2y3.txt", "v1.2.3.txt"), false);
  });

  it("ignores empty pattern lists (matches everything)", () => {
    assert.equal(matchesAny("anything/at/all.ts", []), true);
  });
});

describe("filterIgnored", () => {
  it("filters with the same glob semantics", () => {
    const files = ["src/a.ts", "src/b.ts", "dist/x.js", "package-lock.json"];
    assert.deepEqual(filterIgnored(files, ["dist/**"]), ["src/a.ts", "src/b.ts", "package-lock.json"]);
    assert.deepEqual(filterIgnored(files, ["src/**", "dist/**"]), ["package-lock.json"]);
    assert.deepEqual(filterIgnored(files, []), files);
  });
});

describe("applyDegradedFloor (issue #46)", () => {
  it("a fully-run review keeps its verdict", () => {
    assert.equal(applyDegradedFloor("approve", 2, 2), "approve");
    assert.equal(applyDegradedFloor("request_changes", 3, 3), "request_changes");
  });
  it("a partially-failed review cannot report a clean pass", () => {
    assert.equal(applyDegradedFloor("approve", 1, 2), "comment");
    assert.equal(applyDegradedFloor("approve", 2, 3), "comment");
  });
  it("a degraded review can still escalate", () => {
    assert.equal(applyDegradedFloor("request_changes", 1, 3), "request_changes");
    assert.equal(applyDegradedFloor("comment", 1, 3), "comment");
  });
  it("nothing reviewed is left to the caller's exclusion", () => {
    assert.equal(applyDegradedFloor("approve", 0, 2), "approve");
  });
});

describe("splitDiff / scopeDiff (issue #47)", () => {
  const FILES = ["src/a.ts", "src/b.ts", "website/x.md", "dist/bundle.js"];
  // Exactly the shape getPrDiff() builds.
  const build = (files: string[]) =>
    files
      .map((f) => `--- a/${f}\n+++ b/${f}\n@@ -1,2 +1,3 @@\n ctx\n+added in ${f}\n`)
      .join("\n\n");

  it("splits a multi-file diff into one patch per file", () => {
    const parsed = splitDiff(build(FILES));
    assert.deepEqual(parsed.map((p) => p.file), FILES);
    for (const p of parsed) assert.match(p.patch, /^@@/);
  });

  it("a src/-scoped review sees ZERO bytes of out-of-scope files", () => {
    // The bug: if_paths only decided whether a review ran; agents always got
    // the whole diff, so they paid for (and could comment on) dist/ and docs.
    const parsed = splitDiff(build(FILES));
    const scoped = scopeDiff(["src/a.ts", "src/b.ts"], parsed, FILES.length);
    assert.ok(scoped.includes("src/a.ts") && scoped.includes("src/b.ts"));
    assert.ok(!scoped.includes("website/x.md"), "website leaked into a src/-only review");
    assert.ok(!scoped.includes("dist/bundle.js"), "dist leaked into a src/-only review");
  });

  it("tells the model how much was withheld", () => {
    const scoped = scopeDiff(["src/a.ts"], splitDiff(build(FILES)), FILES.length);
    assert.match(scoped, /OpenReview scope note/);
    assert.match(scoped, /1 of 4 in-scope/);
  });

  it("omits the manifest when nothing was withheld", () => {
    const full = scopeDiff(FILES, splitDiff(build(FILES)), FILES.length);
    for (const f of FILES) assert.ok(full.includes(f), `${f} missing`);
    assert.ok(!full.includes("OpenReview scope note"));
  });

  it("ignores ignore-filtered files only through the caller's file list", () => {
    const inScope = FILES.filter((f) => f !== "dist/bundle.js");
    const parsed = splitDiff(build(FILES));
    const scoped = scopeDiff(inScope, parsed, inScope.length);
    assert.ok(!scoped.includes("dist/bundle.js"));
    assert.ok(!scoped.includes("OpenReview scope note"), "ignore-filtered files are not 'withheld by if_paths'");
  });

  it("is not fooled by header-looking text inside a patch body", () => {
    // An added line reading `+++ b/inner` is written `++++ b/inner` on the
    // wire, and a removed one is `-+++ b/inner`; neither starts with `+++ b/`.
    const tricky =
      '--- a/q.ts\n+++ b/q.ts\n@@ -1 +1,3 @@\n+const s = "+++ b/inner";\n+// --- a/decoy\n-+++ b/removed\n';
    const parsed = splitDiff(tricky);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].file, "q.ts");
    assert.ok(parsed[0].patch.includes('"+++ b/inner"'));
  });

  it("survives empty input", () => {
    assert.deepEqual(splitDiff(""), []);
    assert.equal(scopeDiff([], [], 0), "");
  });

  it("says so plainly when no patch text is available at all", () => {
    // Can't happen when fileNames and the diff come from one call, but if it
    // does the prompt must not read "judge the files above" over nothing.
    const out = scopeDiff(["nope.ts"], splitDiff(build(["a.ts"])), 1);
    assert.match(out, /NO patch text is available/);
    assert.match(out, /Report no findings rather than guessing/);
    assert.ok(!out.includes("Judge only the files above"));
  });
});

describe("combineBallots", () => {
  it("any takes the most severe", () => {
    assert.equal(combineBallots(["approve", "comment", "request_changes"], "any"), "request_changes");
  });
  it("all requires unanimity to escalate", () => {
    assert.equal(combineBallots(["request_changes", "request_changes"], "all"), "request_changes");
    assert.equal(combineBallots(["request_changes", "comment"], "all"), "comment");
    assert.equal(combineBallots(["approve", "request_changes"], "all"), "approve");
  });
  it("an empty ballot set is not a blocking verdict", () => {
    assert.equal(combineBallots([], "any"), "approve");
    assert.equal(combineBallots([], "all"), "approve");
  });
});

describe("decideReviewVerdict", () => {
  it("escalates only at or above min_severity", () => {
    const f = (severity: "high" | "medium" | "suggestion") => [{ severity }];
    assert.equal(decideReviewVerdict("request_changes", "high", f("high")), "request_changes");
    assert.equal(decideReviewVerdict("request_changes", "high", f("medium")), "approve");
    assert.equal(decideReviewVerdict("comment", "suggestion", f("suggestion")), "comment");
    assert.equal(decideReviewVerdict("comment", "medium", []), "approve");
  });
});

describe("noise controls", () => {
  it("quiet preset drops low confidence and caps", () => {
    const q = resolveNoise({ profile: "quiet" });
    assert.equal(q.min_confidence, 0.85);
    assert.equal(q.max_findings, 3);
  });
  it("explicit knobs beat the preset", () => {
    const n = resolveNoise({ profile: "quiet", min_confidence: 0.1, max_findings: 9 });
    assert.deepEqual(n, { min_confidence: 0.1, max_findings: 9 });
  });
  it("always keeps at least one finding", () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ severity: "high" as const, confidence: 0.9, i }));
    assert.equal(applyNoiseControls(many, { min_confidence: 0.5, max_findings: 0 }).visible.length, 1);
  });
  it("orders by severity then confidence", () => {
    const out = applyNoiseControls(
      [
        { severity: "suggestion", confidence: 0.9 },
        { severity: "high", confidence: 0.5 },
        { severity: "high", confidence: 0.9 },
        { severity: "medium", confidence: 0.9 },
      ],
      { min_confidence: 0, max_findings: 50 }
    ).visible;
    assert.deepEqual(out.map((f) => `${f.severity}:${f.confidence}`), [
      "high:0.9",
      "high:0.5",
      "medium:0.9",
      "suggestion:0.9",
    ]);
  });
});

describe("satisfiesActionVersion", () => {
  const cases: [req: string, running: string, ok: boolean][] = [
    [">=1.2.3", "1.2.3", true],
    [">=1.2.3", "1.2.2", false],
    [">1.2.3", "1.2.3", false],
    ["=1.2.3", "1.2.3", true],
    ["1.2.3", "1.2.4", false],
    ["^1.2.3", "1.9.0", true],
    ["^1.2.3", "2.0.0", false],
    ["~1.2.3", "1.2.9", true],
    ["~1.2.3", "1.3.0", false],
    // Unknown/unparseable never blocks (documented fail-open).
    [">=1.2.3", "not-a-version", true],
    ["garbage", "1.0.0", true],
  ];
  for (const [req, running, ok] of cases) {
    it(`${req} vs ${running} -> ${ok}`, () => {
      assert.equal(satisfiesActionVersion(req, running), ok);
    });
  }
});
describe("parseHunkRanges / lineInRanges (issue #53)", () => {
  it("reads new-file ranges from hunk headers", () => {
    const ranges = parseHunkRanges("@@ -1,3 +10,5 @@\n ctx\n@@ -20 +30 @@\n+x\n");
    assert.deepEqual(ranges, [
      { start: 10, end: 14 },
      { start: 30, end: 30 },
    ]);
  });

  it("a deletion-only hunk contributes no commentable lines", () => {
    assert.deepEqual(parseHunkRanges("@@ -5,3 +5,0 @@\n-x\n"), []);
  });

  it("checks lines against ranges", () => {
    const ranges = [{ start: 10, end: 14 }];
    assert.equal(lineInRanges(10, ranges), true);
    assert.equal(lineInRanges(14, ranges), true);
    assert.equal(lineInRanges(9, ranges), false);
    assert.equal(lineInRanges(15, ranges), false);
    assert.equal(lineInRanges(10, []), false);
  });
});

describe("applySuppression (decided items)", () => {
  const F = (file: string, comment: string) => ({ file, comment });
  it("drops findings matching file or comment, case-insensitively", () => {
    const { visible, suppressed } = applySuppression(
      [F("a.ts", "[P1] backdate the config"), F("b.ts", "real bug here"), F("compat.ts", "date check")],
      ["backdate", "compat\\.ts"]
    );
    assert.deepEqual(visible.map((f) => f.file), ["b.ts"]);
    assert.equal(suppressed, 2);
  });
  it("is a no-op without patterns", () => {
    const fs = [F("a.ts", "x")];
    assert.deepEqual(applySuppression(fs, []).visible, fs);
  });
});
