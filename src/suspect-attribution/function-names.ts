
const PLAIN_NAME = /^[A-Za-z_$][\w$]*$/;

export function plainFunctionName(frameFunctionName: string | undefined): string | undefined {
  if (frameFunctionName === undefined) return undefined;
  const withoutKeywords = frameFunctionName.trim().replace(/^(?:async|new)\s+/, "");
  const lastPart = withoutKeywords.split(".").pop() ?? "";
  return PLAIN_NAME.test(lastPart) ? lastPart : undefined;
}

export function escapeForRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function isFunctionDefinitionLine(line: string, functionName: string): boolean {
  if (/^\s*(?:\/\/|\/?\*)/.test(line)) return false;
  const name = escapeForRegex(functionName);
  const definitionPatterns = [
    new RegExp(`\\bfunction\\s*\\*?\\s*${name}\\s*[(<]`),
    new RegExp(`^\\s*(?:export\\s+)?(?:const|let|var)\\s+${name}\\s*(?::[^=]*)?=(?!=)`),
    new RegExp(`^\\s*(?:(?:public|private|protected|static|async|get|set|override)\\s+)*\\*?${name}\\s*[(<].*\\{\\s*$`),
    new RegExp(`^\\s*${name}\\s*:\\s*(?:async\\s+)?(?:function\\b|\\()`),
  ];
  return definitionPatterns.some((pattern) => pattern.test(line));
}

export function findFunctionDefinitionLine(fileContent: string, functionName: string): { lineNumber: number; lineText: string } | undefined {
  const fileLines = fileContent.split("\n");
  const lineIndex = fileLines.findIndex((line) => isFunctionDefinitionLine(line, functionName));
  return lineIndex === -1 ? undefined : { lineNumber: lineIndex + 1, lineText: fileLines[lineIndex]! };
}
