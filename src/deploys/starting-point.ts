import type { Deploy } from "../database/store-types.js";

// True for a service's first deploy: no previous sha, so nothing to blame.
export function isStartingPoint(deploy: Deploy): boolean {
  return deploy.previousSha === null;
}
