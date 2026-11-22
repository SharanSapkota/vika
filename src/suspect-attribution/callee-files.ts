// Finds which repo file defines a function the failing code calls, by
// reading the calling file's imports. JavaScript and TypeScript only.
import { posix } from "node:path";
import { findFunctionDefinitionLine } from "./function-names.js";

export interface CalleeLocation {
  definitionName: string; // the name in the defining file ("import { a as b }" -> "a")
  candidatePaths: string[]; // the file it may be in, most likely first; the caller checks which exists
}

const NAMED_IMPORT = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;
const IMPORTED_NAME = /^(?:type\s+)?([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/;

// TypeScript projects import "./repo.js" but the source file is "./repo.ts".
const SOURCE_EXTENSIONS_FOR: Record<string, string[]> = {
  ".js": [".ts", ".tsx"],
  ".jsx": [".tsx"],
  ".mjs": [".mts"],
  ".cjs": [".cts"],
};
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"];

function resolveImportPaths(importingFilePath: string, importSpecifier: string): string[] {
  const resolvedPath = posix.normalize(posix.join(posix.dirname(importingFilePath), importSpecifier));
  if (resolvedPath === ".." || resolvedPath.startsWith("../")) return []; // outside the repo
  const extension = posix.extname(resolvedPath);
  const sourceExtensions = SOURCE_EXTENSIONS_FOR[extension];
  if (sourceExtensions !== undefined) {
    const pathWithoutExtension = resolvedPath.slice(0, -extension.length);
    return [...sourceExtensions.map((sourceExtension) => pathWithoutExtension + sourceExtension), resolvedPath];
  }
  if (SOURCE_EXTENSIONS.includes(extension)) return [resolvedPath];
  return [`${resolvedPath}.ts`, `${resolvedPath}.tsx`, `${resolvedPath}.js`, `${resolvedPath}/index.ts`, `${resolvedPath}/index.js`];
}

// Undefined when the function comes from a package (not this repo's code)
// or can't be found at all.
export function findCalleeLocation(fileContent: string, filePath: string, calleeName: string): CalleeLocation | undefined {
  for (const importMatch of fileContent.matchAll(NAMED_IMPORT)) {
    const importSpecifier = importMatch[2]!;
    for (const importedItem of importMatch[1]!.split(",")) {
      const nameMatch = IMPORTED_NAME.exec(importedItem.trim());
      if (!nameMatch) continue;
      const localName = nameMatch[2] ?? nameMatch[1]!;
      if (localName !== calleeName) continue;
      // Only relative imports point into the repo; anything else is a package.
      if (!importSpecifier.startsWith(".")) return undefined;
      const candidatePaths = resolveImportPaths(filePath, importSpecifier);
      return candidatePaths.length === 0 ? undefined : { definitionName: nameMatch[1]!, candidatePaths };
    }
  }
  // Not imported: maybe defined in the same file.
  if (findFunctionDefinitionLine(fileContent, calleeName) !== undefined) return { definitionName: calleeName, candidatePaths: [filePath] };
  return undefined;
}
