import { escapeForRegex } from "./function-names.js";
import { measureIndentation, removePythonStringsAndComments } from "./python-source-text.js";

const PLAIN_NAME = /^[A-Za-z_]\w*$/;

export interface FunctionLineRange {
  startLine: number;
  endLine: number;
}



export function readPythonFunctionName(frameFunctionName: string | undefined): string | undefined {
  if (frameFunctionName === undefined) return undefined;
  const lastPart = frameFunctionName.trim().split(".").pop() ?? "";
  return PLAIN_NAME.test(lastPart) ? lastPart : undefined;
}



function definitionPattern(functionName: string): RegExp {
  return new RegExp(`^\\s*(?:async\\s+)?def\\s+${escapeForRegex(functionName)}\\s*[(\\[]`);
}

export function findPythonFunctionDefinitionLine(fileContent: string, functionName: string): { lineNumber: number; lineText: string } | undefined {
  const fileLines = fileContent.split("\n");
  const pattern = definitionPattern(functionName);
  const lineIndex = fileLines.findIndex((line) => pattern.test(line));
  return lineIndex === -1 ? undefined : { lineNumber: lineIndex + 1, lineText: fileLines[lineIndex]! };
}



function measureFunction(fileLines: string[], definitionIndex: number): FunctionLineRange {
  const definitionIndentation = measureIndentation(fileLines[definitionIndex]!);
  let startIndex = definitionIndex;
  while (startIndex > 0 && /^\s*@/.test(fileLines[startIndex - 1]!) && measureIndentation(fileLines[startIndex - 1]!) === definitionIndentation) startIndex--;

  
  
  let bracketDepth = 0;
  for (let lineIndex = definitionIndex; lineIndex < fileLines.length; lineIndex++) {
    const code = removePythonStringsAndComments(fileLines[lineIndex]!);
    for (let characterIndex = 0; characterIndex < code.length; characterIndex++) {
      const character = code[characterIndex]!;
      if ("([{".includes(character)) bracketDepth++;
      else if (")]}".includes(character)) bracketDepth--;
      else if (character === ":" && bracketDepth <= 0) {
        if (code.slice(characterIndex + 1).trim() !== "") return { startLine: startIndex + 1, endLine: lineIndex + 1 };
        let endIndex = lineIndex;
        for (let bodyIndex = lineIndex + 1; bodyIndex < fileLines.length; bodyIndex++) {
          const bodyLine = fileLines[bodyIndex]!;
          if (bodyLine.trim() === "") continue;
          if (measureIndentation(bodyLine) <= definitionIndentation) break;
          endIndex = bodyIndex;
        }
        return { startLine: startIndex + 1, endLine: endIndex + 1 };
      }
    }
  }
  return { startLine: startIndex + 1, endLine: definitionIndex + 1 };
}







export function findPythonFunctionLineRange(fileContent: string, functionName: string, lineNumberInside?: number): FunctionLineRange | undefined {
  const fileLines = fileContent.split("\n");
  const pattern = definitionPattern(functionName);
  const ranges: FunctionLineRange[] = [];
  fileLines.forEach((line, lineIndex) => {
    if (pattern.test(line)) ranges.push(measureFunction(fileLines, lineIndex));
  });
  if (lineNumberInside === undefined) return ranges[0];
  const holdingRanges = ranges.filter((range) => range.startLine <= lineNumberInside && lineNumberInside <= range.endLine);
  return holdingRanges.sort((left, right) => left.endLine - left.startLine - (right.endLine - right.startLine))[0];
}
