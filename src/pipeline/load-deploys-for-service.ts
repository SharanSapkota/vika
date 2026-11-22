// Brings a service's deploy timeline up to date and returns it.
//   "merges": every commit on the service's branch (only those touching
//             pathPrefix, in a monorepo) is a deploy; read from git
//             (read-only) and saved. Saving twice is safe.
//   "marker": deploys come from `vika mark-deploy`; only read what's stored.
//   others:   not supported yet; say so, use what's stored, don't fail.
import type { ServiceSettings } from "../configuration/configuration-schema.js";
import type { Deploy, Store } from "../database/store-types.js";
import { readMergeDeploys } from "../deploys/read-merge-deploys.js";
import { recordDeploys } from "../deploys/record-deploys.js";

export interface DeployLoadResult {
  deploys: Deploy[]; // everything stored for the service, oldest first
  addedCount: number; // new deploys saved by this run
  note: string | null;
}

export async function loadDeploysForService(store: Store, serviceName: string, serviceSettings: ServiceSettings): Promise<DeployLoadResult> {
  const source = serviceSettings.deploys.source;
  let addedCount = 0;
  let note: string | null = null;

  if (source === "merges") {
    const deploysFromGit = await readMergeDeploys(serviceSettings.repo, serviceSettings.branch, serviceName, serviceSettings.pathPrefix);
    addedCount = (await recordDeploys(store, deploysFromGit)).added;
  } else if (source !== "marker") {
    note = `deploys.source "${source}" is not supported yet; using only deploys already stored (for example from vika mark-deploy)`;
  }

  return { deploys: await store.listDeploys(serviceName), addedCount, note };
}
