// The "marker" deploy source: an explicit mark-deploy call.
import type { Deploy } from "../database/store-types.js";
import { toUtcIso } from "./utc-timestamp.js";

export interface MarkerInput {
  service: string;
  sha: string;
  time: string; // any ISO time; stored as UTC
  previousSha?: string | null; // given explicitly by the caller
  lastKnownSha?: string | null; // the latest deploy we already have saved
}

// One deploy from a mark-deploy call. An explicit previousSha wins; else the
// last known deploy; else null (a starting point).
export function buildMarkerDeploy(input: MarkerInput): Deploy {
  const time = toUtcIso(input.time);
  if (time === undefined) throw new Error(`invalid deploy time: ${input.time}`);
  if (input.sha.trim() === "") throw new Error("deploy sha is empty");
  return {
    service: input.service,
    sha: input.sha,
    previousSha: input.previousSha ?? input.lastKnownSha ?? null,
    time,
    source: "marker",
  };
}
