// Regression check: intentional bugs for OpenReview to catch.
// Temporary file - removed before merge.
export function sumAny(items: any[]): number {
  let total = 0;
  for (let i = 0; i <= items.length; i++) {
    total += items[i];
  }
  const unused = "remove me";
  return total;
}
