export function extractPrNumber(subject: string): number | null {
  const prNumberMatch = /\(#(\d+)\)\s*$/.exec(subject) ?? /^Merge pull request #(\d+) from /.exec(subject);
  return prNumberMatch?.[1] ? Number(prNumberMatch[1]) : null;
}
