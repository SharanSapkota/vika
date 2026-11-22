// Finds what the failing line depends on, inside its own function:
//   - lines above it that set a variable it reads ("const user = ...")
//   - functions whose return value it reads ("const user = getUser(...)",
//     or a call on the failing line itself)
// A bug is often not on the line that throws but in where its values came
// from: "user.email" fails because getUser() started returning null.
//
// A plain-text heuristic for JavaScript and TypeScript. It follows one step
// only (not the inputs of the inputs), which keeps it simple and predictable.
import { isFunctionDefinitionLine } from "./function-names.js";

// If the function's definition line can't be found (no name in the stack
// frame, or an unusual definition), look this many lines above the failing line.
const FALLBACK_LOOKBACK_LINES = 30;
// Give up looking for the definition line after this many lines: further up
// it is more likely another function with the same name.
const MAX_FUNCTION_LINES = 300;

const KEYWORDS = new Set([
  "await", "break", "case", "catch", "class", "const", "continue", "default", "delete", "do", "else",
  "export", "extends", "false", "finally", "for", "function", "if", "import", "in", "instanceof",
  "let", "new", "null", "of", "return", "super", "switch", "this", "throw", "true", "try", "typeof",
  "undefined", "var", "void", "while", "yield", "as", "async",
]);

const IDENTIFIER = /(?<![\w$.])[A-Za-z_$][\w$]*/g;
const CALLED_IDENTIFIER = /(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(/g;
const ASSIGNMENT = /^\s*(?:const|let|var)?\s*([A-Za-z_$][\w$]*)\s*=(?![=>])\s*(.*)$/;
const DIRECT_CALL_START = /^(?:await\s+)?([A-Za-z_$][\w$]*)\s*\(/;

export interface CrashLineInputs {
  inputLineNumbers: number[]; // lines in the function that set a value the failing line reads
  calleeNames: string[]; // functions whose return value the failing line reads
}

// Strings and comments can hold words that look like names; blank them out.
function removeStringsAndComments(line: string): string {
  return line.replace(/(["'`])(?:\\.|(?!\1)[^\\])*\1/g, '""').replace(/\/\/.*$/, "");
}

// Names the line reads: identifiers that are not property names (after ".")
// and not keywords. The name a declaration creates is not read.
function findReadNames(code: string): Set<string> {
  const declaredName = /^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/.exec(code)?.[1];
  const readNames = new Set<string>();
  for (const identifierMatch of code.matchAll(IDENTIFIER)) {
    const name = identifierMatch[0];
    if (!KEYWORDS.has(name) && name !== declaredName) readNames.add(name);
  }
  return readNames;
}

// The index of the failing function's definition line, or the fallback
// starting point when it can't be found.
function findFunctionStartIndex(fileLines: string[], crashIndex: number, functionName: string | undefined): number {
  if (functionName !== undefined) {
    for (let lineIndex = crashIndex - 1; lineIndex >= Math.max(0, crashIndex - MAX_FUNCTION_LINES); lineIndex--) {
      if (isFunctionDefinitionLine(fileLines[lineIndex]!, functionName)) return lineIndex;
    }
  }
  return Math.max(0, crashIndex - FALLBACK_LOOKBACK_LINES) - 1;
}

export function findCrashLineInputs(fileContent: string, crashLineNumber: number, functionName: string | undefined): CrashLineInputs {
  const fileLines = fileContent.split("\n");
  const crashIndex = crashLineNumber - 1;
  const crashLine = fileLines[crashIndex];
  if (crashLine === undefined) return { inputLineNumbers: [], calleeNames: [] };

  const crashCode = removeStringsAndComments(crashLine);
  const readNames = findReadNames(crashCode);
  const calleeNames = new Set<string>();
  for (const callMatch of crashCode.matchAll(CALLED_IDENTIFIER)) {
    if (!KEYWORDS.has(callMatch[1]!)) calleeNames.add(callMatch[1]!);
  }

  const inputLineNumbers: number[] = [];
  const functionStartIndex = findFunctionStartIndex(fileLines, crashIndex, functionName);
  // The definition line itself only holds parameters, so start below it.
  for (let lineIndex = functionStartIndex + 1; lineIndex < crashIndex; lineIndex++) {
    const assignmentMatch = ASSIGNMENT.exec(removeStringsAndComments(fileLines[lineIndex]!));
    if (!assignmentMatch || !readNames.has(assignmentMatch[1]!)) continue;
    inputLineNumbers.push(lineIndex + 1);
    const calleeName = DIRECT_CALL_START.exec(assignmentMatch[2]!.trim())?.[1];
    if (calleeName !== undefined && !KEYWORDS.has(calleeName)) calleeNames.add(calleeName);
  }

  return { inputLineNumbers, calleeNames: [...calleeNames].sort() };
}
