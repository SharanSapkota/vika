import type { PathMap } from "./suspect-types.js";

const removeLeadingDotSlash = (filePath: string) => filePath.replace(/^(?:\.\/)+/, "");

function isPrefixOf(prefix: string, framePath: string): boolean {
  if (prefix === "" || !framePath.startsWith(prefix)) return false;
  return prefix.endsWith("/") || framePath.length === prefix.length || framePath[prefix.length] === "/";
}

export function applyPathMap(framePath: string, pathMap: PathMap | undefined): string {
  const matchingPrefixes = Object.keys(pathMap ?? {}).filter((prefix) => isPrefixOf(prefix, framePath));
  if (pathMap === undefined || matchingPrefixes.length === 0) return removeLeadingDotSlash(framePath);
  const longestPrefix = matchingPrefixes.reduce((longest, prefix) => (prefix.length > longest.length ? prefix : longest));
  const mappedPath = pathMap[longestPrefix]! + framePath.slice(longestPrefix.length);
  return removeLeadingDotSlash(mappedPath.replace(/\/{2,}/g, "/").replace(/^\/+/, ""));
}

export function isRepoRelativePath(filePath: string): boolean {
  return (
    filePath !== "" &&
    !filePath.startsWith("/") &&
    !filePath.startsWith("-") &&
    !/^[A-Za-z][\w+.-]*:/.test(filePath) &&
    !filePath.split("/").includes("..")
  );
}
