import { applyPathMap, isRepoRelativePath } from "../suspect-attribution/apply-path-map.js";
import type { PathMap } from "../suspect-attribution/suspect-types.js";

export type PathMapAdvice =
  | { kind: "no stack traces" }
  | { kind: "paths found"; checkedCount: number }
  | { kind: "suggestion"; serverPrefix: string; repoPrefix: string; examplePath: string }
  | { kind: "not found"; examplePath: string };

export async function adviseOnPathMap(
  framePaths: string[],
  pathMap: PathMap | undefined,
  doesRepoFileExist: (repoPath: string) => Promise<boolean>,
): Promise<PathMapAdvice> {
  const appFramePaths = [...new Set(framePaths)].filter((framePath) => !framePath.includes("node_modules/") && !/^[A-Za-z]+:/.test(framePath));
  if (appFramePaths.length === 0) return { kind: "no stack traces" };

  let checkedCount = 0;
  for (const framePath of appFramePaths) {
    const mappedPath = applyPathMap(framePath, pathMap);
    if (isRepoRelativePath(mappedPath) && (await doesRepoFileExist(mappedPath))) checkedCount++;
  }
  if (checkedCount > 0) return { kind: "paths found", checkedCount };

  for (const framePath of appFramePaths) {
    const pathParts = framePath.split("/");
    for (let droppedCount = 1; droppedCount < pathParts.length; droppedCount++) {
      const repoPath = pathParts.slice(droppedCount).join("/");
      if (repoPath === "" || !isRepoRelativePath(repoPath) || !(await doesRepoFileExist(repoPath))) continue;
      const hasFolder = droppedCount < pathParts.length - 1;
      const keptCount = hasFolder ? droppedCount + 1 : droppedCount;
      const serverPrefix = pathParts.slice(0, keptCount).join("/");
      return { kind: "suggestion", serverPrefix: serverPrefix === "" ? "/" : serverPrefix, repoPrefix: hasFolder ? pathParts[droppedCount]! : "", examplePath: framePath };
    }
  }
  return { kind: "not found", examplePath: appFramePaths[0]! };
}
