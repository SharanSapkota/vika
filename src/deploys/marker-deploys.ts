import type { Deploy } from "../database/store-types.js";
import { toUtcIso } from "./utc-timestamp.js";

export interface MarkerInput {
  service: string;
  sha: string;
  time: string;
  previousSha?: string | null;
  lastKnownSha?: string | null;
}

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
