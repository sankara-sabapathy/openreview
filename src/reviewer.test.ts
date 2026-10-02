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