// Function names from stack frames, and where a function is defined in a file.
// The definition matcher is a plain-text heuristic for JavaScript and
// TypeScript; for other languages it simply finds nothing.

const PLAIN_NAME = /^[A-Za-z_$][\w$]*$/;

// Stack frames name functions in many ways: "createOrder", "Layer.handle",
// "async handleRequest", "new OrderService", "Object.<anonymous>". git needs
// the plain name as it appears in the source ("handle", "OrderService"), or
// nothing when there is no usable name.
export function plainFunctionName(frameFunctionName: string | undefined): string | undefined {
  if (frameFunctionName === undefined) return undefined;
  const withoutKeywords = frameFunctionName.trim().replace(/^(?:async|new)\s+/, "");
  const lastPart = withoutKeywords.split(".").pop() ?? "";
  return PLAIN_NAME.test(lastPart) ? lastPart : undefined;
}

export function escapeForRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Does this line define `functionName`? Recognizes
//   function name(...)                       (also "export", "async", "function*")
//   const name = (...) => / const name = function
//   name(...) {                              (a class method; a plain call has no "{")
//   name: (...) => / name: function          (an object property)
export function isFunctionDefinitionLine(line: string, functionName: string): boolean {
  if (/^\s*(?:\/\/|\/?\*)/.test(line)) return false; // comment lines
  const name = escapeForRegex(functionName);
  const definitionPatterns = [
    new RegExp(`\\bfunction\\s*\\*?\\s*${name}\\s*[(<]`),
    new RegExp(`^\\s*(?:export\\s+)?(?:const|let|var)\\s+${name}\\s*(?::[^=]*)?=(?!=)`),
    new RegExp(`^\\s*(?:(?:public|private|protected|static|async|get|set|override)\\s+)*\\*?${name}\\s*[(<].*\\{\\s*$`),
    new RegExp(`^\\s*${name}\\s*:\\s*(?:async\\s+)?(?:function\\b|\\()`),
  ];
  return definitionPatterns.some((pattern) => pattern.test(line));
}

// The first line that defines `functionName`, or undefined.
export function findFunctionDefinitionLine(fileContent: string, functionName: string): { lineNumber: number; lineText: string } | undefined {
  const fileLines = fileContent.split("\n");
  const lineIndex = fileLines.findIndex((line) => isFunctionDefinitionLine(line, functionName));
  return lineIndex === -1 ? undefined : { lineNumber: lineIndex + 1, lineText: fileLines[lineIndex]! };
}
