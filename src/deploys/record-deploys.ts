import type { Deploy, Store } from "../database/store-types.js";

export async function recordDeploys(store: Pick<Store, "saveDeploy">, deploys: Deploy[]): Promise<{ added: number; alreadyKnown: number }> {
  let added = 0;
  for (const deploy of deploys) {
    if (await store.saveDeploy(deploy)) added++;
  }
  return { added, alreadyKnown: deploys.length - added };
}
