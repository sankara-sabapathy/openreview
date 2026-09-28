// Dogfood fixture: intentional nits for OpenReview to find once a provider key is set.
// This file is temporary and will be removed before merge.
export function sumAny(items: any[]): number {
  let total = 0;
  for (let i = 0; i <= items.length; i++) {
    total += items[i];
  }
  const unused = "remove me";
  return total;
}
