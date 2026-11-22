// Turns a stack frame path from the running server into a path in the repo.
import type { PathMap } from "./suspect-types.js";

// "./src/a.ts" means "src/a.ts" to git.
const removeLeadingDotSlash = (filePath: string) => filePath.replace(/^(?:\.\/)+/, "");

// A prefix matches a whole folder name, not part of one: "/app" matches
// "/app/src/a.ts" but not "/application/a.ts".
function isPrefixOf(prefix: string, framePath: string): boolean {
  if (prefix === "" || !framePath.startsWith(prefix)) return false;
  return prefix.endsWith("/") || framePath.length === prefix.length || framePath[prefix.length] === "/";
}

// With several prefixes, the longest matching one wins, so a specific rule
// ("/app/src/vendor") beats a general one ("/app/src").
export function applyPathMap(framePath: string, pathMap: PathMap | undefined): string {
  const matchingPrefixes = Object.keys(pathMap ?? {}).filter((prefix) => isPrefixOf(prefix, framePath));
  if (pathMap === undefined || matchingPrefixes.length === 0) return removeLeadingDotSlash(framePath);
  const longestPrefix = matchingPrefixes.reduce((longest, prefix) => (prefix.length > longest.length ? prefix : longest));
  const mappedPath = pathMap[longestPrefix]! + framePath.slice(longestPrefix.length);
  // A mapped path is relative to the repo, so doubled and leading slashes go.
  return removeLeadingDotSlash(mappedPath.replace(/\/{2,}/g, "/").replace(/^\/+/, ""));
}

// Only plain repo-relative paths can be looked up in git. Absolute paths
// (no path map, or a frame outside the app), "node:internal/..." frames and
// paths that climb out of the repo are left out.
export function isRepoRelativePath(filePath: string): boolean {
  return (
    filePath !== "" &&
    !filePath.startsWith("/") &&
    !filePath.startsWith("-") &&
    !/^[A-Za-z][\w+.-]*:/.test(filePath) &&
    !filePath.split("/").includes("..")
  );
}
