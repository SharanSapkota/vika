import { posix } from "node:path";
import type { CalleeLocation } from "./callee-files.js";
import { findPythonFunctionDefinitionLine } from "./python-function-names.js";



const FROM_IMPORT = /^[ \t]*from[ \t]+(\.*[\w.]*)[ \t]+import[ \t]+(\([^)]*\)|[^\n#]+)/gm;

const PLAIN_IMPORT = /^[ \t]*import[ \t]+([^\n#]+)/gm;
const IMPORTED_ITEM = /^([A-Za-z_][\w.]*)(?:\s+as\s+([A-Za-z_]\w*))?$/;



interface ImportedName {
  moduleName: string;
  importedName: string | null;
}

function readImportedNames(fileContent: string): Map<string, ImportedName> {
  const importedNames = new Map<string, ImportedName>();
  for (const importMatch of fileContent.matchAll(FROM_IMPORT)) {
    const items = importMatch[2]!.replace(/[()]/g, "").split(",");
    for (const item of items) {
      const itemMatch = IMPORTED_ITEM.exec(item.replace(/#.*$/gm, "").trim());
      if (!itemMatch) continue;
      importedNames.set(itemMatch[2] ?? itemMatch[1]!, { moduleName: importMatch[1]!, importedName: itemMatch[1]! });
    }
  }
  for (const importMatch of fileContent.matchAll(PLAIN_IMPORT)) {
    for (const item of importMatch[1]!.split(",")) {
      const itemMatch = IMPORTED_ITEM.exec(item.trim());
      if (!itemMatch) continue;
      
      const localName = itemMatch[2] ?? itemMatch[1]!.split(".")[0]!;
      importedNames.set(localName, { moduleName: itemMatch[2] === undefined ? localName : itemMatch[1]!, importedName: null });
    }
  }
  return importedNames;
}

function moduleFilePaths(modulePath: string): string[] {
  if (modulePath === "" || modulePath === ".") return ["__init__.py"];
  return [`${modulePath}.py`, `${modulePath}/__init__.py`];
}







export function findModuleFilePaths(importingFilePath: string, moduleName: string): string[] {
  const leadingDotCount = /^\.*/.exec(moduleName)![0].length;
  const moduleFolders = moduleName.slice(leadingDotCount).split(".").filter((part) => part !== "").join("/");

  if (leadingDotCount > 0) {
    const parentSteps = Array.from({ length: leadingDotCount - 1 }, () => "..");
    const baseFolder = posix.normalize(posix.join(posix.dirname(importingFilePath), ...parentSteps));
    if (baseFolder === ".." || baseFolder.startsWith("../")) return [];
    
    if (moduleFolders === "") return [baseFolder === "." ? "__init__.py" : `${baseFolder}/__init__.py`];
    return moduleFilePaths(posix.normalize(posix.join(baseFolder, moduleFolders)));
  }

  const parentFolders: string[] = [];
  for (let folder = posix.dirname(importingFilePath); ; folder = posix.dirname(folder)) {
    parentFolders.push(folder);
    if (folder === "." || folder === "/") break;
  }
  return parentFolders.flatMap((folder) => moduleFilePaths(folder === "." ? moduleFolders : `${folder}/${moduleFolders}`));
}

function joinModuleName(moduleName: string, childName: string): string {
  return moduleName.endsWith(".") ? `${moduleName}${childName}` : `${moduleName}.${childName}`;
}



export function findPythonCalleeLocation(fileContent: string, filePath: string, calleeName: string): CalleeLocation | undefined {
  const [firstName, secondName] = calleeName.split(".") as [string, string | undefined];
  const importedNames = readImportedNames(fileContent);

  if (secondName === undefined) {
    const imported = importedNames.get(firstName);
    if (imported !== undefined) {
      if (imported.importedName === null) return undefined;
      const candidatePaths = findModuleFilePaths(filePath, imported.moduleName);
      return candidatePaths.length === 0 ? undefined : { definitionName: imported.importedName, candidatePaths };
    }
    if (findPythonFunctionDefinitionLine(fileContent, firstName) !== undefined) return { definitionName: firstName, candidatePaths: [filePath] };
    return undefined;
  }

  if (firstName === "self" || firstName === "cls") {
    return findPythonFunctionDefinitionLine(fileContent, secondName) === undefined ? undefined : { definitionName: secondName, candidatePaths: [filePath] };
  }
  const imported = importedNames.get(firstName);
  if (imported === undefined) return undefined;
  const moduleName = imported.importedName === null ? imported.moduleName : joinModuleName(imported.moduleName, imported.importedName);
  const candidatePaths = findModuleFilePaths(filePath, moduleName);
  return candidatePaths.length === 0 ? undefined : { definitionName: secondName, candidatePaths };
}
