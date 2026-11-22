// Any ISO time -> UTC ISO ("...Z"), or undefined if it isn't a time.
export function toUtcIso(text: string): string | undefined {
  const timestampMs = Date.parse(text);
  return Number.isNaN(timestampMs) ? undefined : new Date(timestampMs).toISOString();
}
