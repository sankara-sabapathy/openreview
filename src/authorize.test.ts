import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { authorizeTrigger, DEFAULT_ALLOWED_ASSOCIATIONS } from "./authorize.js";

const base = { command: "/review" };

describe("authorizeTrigger", () => {
  it("does not gate pull_request (pushing already required write access)", () => {
    assert.deepEqual(authorizeTrigger({ ...base, eventName: "pull_request" }), { allowed: true });
  });

  it("allows a maintainer sending exactly the command", () => {
    for (const assoc of DEFAULT_ALLOWED_ASSOCIATIONS) {
      assert.deepEqual(
        authorizeTrigger({
          ...base,
          eventName: "issue_comment",
          commentBody: "/review",
          authorAssociation: assoc,
        }),
        { allowed: true }
      );
    }
  });

  it("tolerates surrounding whitespace and case", () => {
    assert.deepEqual(
      authorizeTrigger({
        ...base,
        eventName: "issue_comment",
        commentBody: "  /REVIEW\n",
        authorAssociation: "OWNER",
      }),
      { allowed: true }
    );
  });

  it("denies untrusted senders — the open-wallet case", () => {
    for (const assoc of ["NONE", "CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR", "FIRST_TIMER"]) {
      const r = authorizeTrigger({
        ...base,
        eventName: "issue_comment",
        commentBody: "/review",
        authorAssociation: assoc,
      });
      assert.equal(r.allowed, false, `${assoc} must not be able to spend the repo's keys`);
      assert.match((r as { reason: string }).reason, /may not trigger/);
    }
  });

  it("denies an unknown or missing association (fail closed)", () => {
    for (const assoc of [undefined, "", "  "]) {
      const r = authorizeTrigger({
        ...base,
        eventName: "issue_comment",
        commentBody: "/review",
        authorAssociation: assoc,
      });
      assert.equal(r.allowed, false);
    }
  });

  it("requires an exact command — no substring matches", () => {
    // The old workflow used contains(body, '/review'), which also fired on
    // "/reviewer", "please /review this" and quoted text.
    for (const body of [
      "/reviewer",
      "please /review this",
      "I think we should /review later",
      "```\n/review\n```",
      "@bot /review",
      "review",
    ]) {
      const r = authorizeTrigger({
        ...base,
        eventName: "issue_comment",
        commentBody: body,
        authorAssociation: "OWNER",
      });
      assert.equal(r.allowed, false, `'${body}' must not trigger a review`);
    }
  });

  it("honors a custom association list", () => {
    const input = {
      ...base,
      eventName: "issue_comment",
      commentBody: "/review",
      allowedAssociations: "OWNER, COLLABORATOR , contributor",
    };
    assert.deepEqual(authorizeTrigger({ ...input, authorAssociation: "OWNER" }), { allowed: true });
    assert.deepEqual(authorizeTrigger({ ...input, authorAssociation: "CONTRIBUTOR" }), {
      allowed: true,
    });
    assert.equal(authorizeTrigger({ ...input, authorAssociation: "MEMBER" }).allowed, false);
  });

  it("treats an empty association list as the default (never allow-all)", () => {
    const r = authorizeTrigger({
      ...base,
      eventName: "issue_comment",
      commentBody: "/review",
      allowedAssociations: " , ",
      authorAssociation: "NONE",
    });
    assert.equal(r.allowed, false);
  });

  it("follows a reconfigured command", () => {
    assert.deepEqual(
      authorizeTrigger({
        ...base,
        command: "/ask",
        eventName: "issue_comment",
        commentBody: "/ask",
        authorAssociation: "OWNER",
      }),
      { allowed: true }
    );
    assert.equal(
      authorizeTrigger({
        ...base,
        command: "/ask",
        eventName: "issue_comment",
        commentBody: "/review",
        authorAssociation: "OWNER",
      }).allowed,
      false
    );
  });

  it("disables the command path when no command is configured", () => {
    assert.deepEqual(
      authorizeTrigger({
        ...base,
        command: "",
        eventName: "issue_comment",
        commentBody: "/review",
        authorAssociation: "NONE",
      }),
      { allowed: true }
    );
  });
});