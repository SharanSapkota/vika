// Time helpers the detector shares. All times inside the detector are epoch ms.

export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;

export function parseTimeMs(isoTimestamp: string, description: string): number {
  const timestampMs = Date.parse(isoTimestamp);
  if (Number.isNaN(timestampMs)) throw new Error(`invalid ${description}: ${isoTimestamp}`);
  return timestampMs;
}

export const floorToMinuteMs = (timestampMs: number) => Math.floor(timestampMs / MINUTE_MS) * MINUTE_MS;

export const toIsoTimestamp = (timestampMs: number) => new Date(timestampMs).toISOString();
