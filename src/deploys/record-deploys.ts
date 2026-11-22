import type { Deploy, Store } from "../database/store-types.js";

// Saves deploys through the store. Duplicates are ignored by the store, so
// saving the same deploys again is safe. Takes the store as a parameter and
// never touches the database directly.
export async function recordDeploys(store: Pick<Store, "saveDeploy">, deploys: Deploy[]): Promise<{ added: number; alreadyKnown: number }> {
  let added = 0;
  for (const deploy of deploys) {
    if (await store.saveDeploy(deploy)) added++;
  }
  return { added, alreadyKnown: deploys.length - added };
}
