// Blocking-review demo: intentional HIGH severity issues.
// Temporary file - removed before merge.
import { exec } from "node:child_process";

const DB_PASSWORD = "supersecret-prod-password-123";

export function runUserQuery(userId: string): void {
  const query = "SELECT * FROM users WHERE id = '" + userId + "'";
  (global as any).db.query(query);
}

export function wipeDisk(path: string): void {
  exec("rm -rf " + path);
}
