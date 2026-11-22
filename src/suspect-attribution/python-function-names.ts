import { escapeForRegex } from "./function-names.js";
import { measureIndentation, removePythonStringsAndComments } from "./python-source-text.js";

const PLAIN_NAME = /^[A-Za-z_]\w*$/;

export interface FunctionLineRange {
  startLine: number;
  endLine: number;
}

// "create_order" stays; "<module>", "<lambda>" and "<listcomp>" are not
// functions anyone wrote by that name, so they give no name.
export function readPythonFunctionName(frameFunctionName: string | undefined): string | undefined {
  if (frameFunctionName === undefined) return undefined;
  const lastPart = frameFunctionName.trim().split(".").pop() ?? "";
  return PLAIN_NAME.test(lastPart) ? lastPart : undefined;
}

// `def name(`, `async def name(` and `def name[T](`, at any indentation, so
// methods inside a class count too.
function definitionPattern(functionName: string): RegExp {
  return new RegExp(`^\\s*(?:async\\s+)?def\\s+${escapeForRegex(functionName)}\\s*[(\\[]`);
}

export function findPythonFunctionDefinitionLine(fileContent: string, functionName: string): { lineNumber: number; lineText: string } | undefined {
  const fileLines = fileContent.split("\n");
  const pattern = definitionPattern(functionName);
  const lineIndex = fileLines.findIndex((line) => pattern.test(line));
  return lineIndex === -1 ? undefined : { lineNumber: lineIndex + 1, lineText: fileLines[lineIndex]! };
}

// The lines of one function: its decorators, its signature (which may span
// several lines) and every line indented deeper than the `def` below it.
function measureFunction(fileLines: string[], definitionIndex: number): FunctionLineRange {
  const definitionIndentation = measureIndentation(fileLines[definitionIndex]!);
  let startIndex = definitionIndex;
  while (startIndex > 0 && /^\s*@/.test(fileLines[startIndex - 1]!) && measureIndentation(fileLines[startIndex - 1]!) === definitionIndentation) startIndex--;

  // The signature ends at the first ":" outside brackets. Code after that
  // colon on the same line means a one-line function.
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

// Finds a function's lines from its indentation. `git log -L :name:file`
// is not used for Python: git's default rules miss methods inside a class,
// and for a name that is also imported at the top of the file, git matches
// the import line and silently checks the wrong lines.
// With `lineNumberInside`, the innermost function holding that line is
// chosen (the same name can be defined in several classes).
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
