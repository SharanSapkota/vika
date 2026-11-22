import type { Deploy } from "../database/store-types.js";

export function isStartingPoint(deploy: Deploy): boolean {
  return deploy.previousSha === null;
}
