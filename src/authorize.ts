/**
 * Who may spend the repo's BYOK budget, and by what command.
 *
 * `issue_comment` events run in the BASE repo context, so the workflow's
 * secrets are fully available. Without a gate, any GitHub user could comment
 * `/review` on any PR (including a fork) and have the action spend the
 * maintainer's provider keys — an open wallet for the whole internet. The
 * workflow `if:` can filter this, but a workflow is per-repo and easy to leave
 * stale, so the action enforces it too.
 *
 * Rules for `issue_comment`:
 * 1. the body must be exactly the configured command (trimmed) — `contains()`
 *    style matching also fires on "/reviewer", quoted text, and code blocks;
 * 2. the sender must hold write access (author_association OWNER / MEMBER /
 *    COLLABORATOR by default). PR authors from forks are NOT allowed by
 *    default: authorizing them means authorizing anyone.
 *
 * `pull_request` is unaffected — pushing the branch already required write
 * access, and GitHub withholds secrets from fork PRs.
 */

/** GitHub's `author_association` values that imply write access. */
export const DEFAULT_ALLOWED_ASSOCIATIONS = ["OWNER", "MEMBER", "COLLABORATOR"];

export type AuthorizeInput = {
  /** GITHUB_EVENT_NAME; only `issue_comment` is gated. */
  eventName: string;
  /** `payload.comment.body` for issue_comment. */
  commentBody?: string;
  /** `payload.comment.author_association` for issue_comment. */
  authorAssociation?: string;
  /** Configured command, e.g. `defaults.command` ("/review"). */
  command: string;
  /** Allowed author_association values; empty means "default set". */
  allowedAssociations?: string;
};

export type AuthorizeResult = { allowed: true } | { allowed: false; reason: string };

function parseAssociations(raw: string | undefined): string[] {
  const list = (raw ?? "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  return list.length > 0 ? list : DEFAULT_ALLOWED_ASSOCIATIONS;
}

export function authorizeTrigger(input: AuthorizeInput): AuthorizeResult {
  if (input.eventName !== "issue_comment") return { allowed: true };

  const body = (input.commentBody ?? "").trim();
  const command = input.command.trim();
  if (!command) return { allowed: true }; // no command configured -> command path disabled
  if (body.toLowerCase() !== command.toLowerCase()) {
    return { allowed: false, reason: `comment is not the configured command (${command})` };
  }

  const allowed = parseAssociations(input.allowedAssociations);
  const association = (input.authorAssociation ?? "NONE").trim().toUpperCase();
  if (!allowed.includes(association)) {
    return {
      allowed: false,
      reason: `sender association '${association}' may not trigger a review (allowed: ${allowed.join(", ")})`,
    };
  }
  return { allowed: true };
}