import type { CrashLineInputs } from "./crash-line-inputs.js";
import { findPythonFunctionLineRange } from "./python-function-names.js";
import { removePythonStringsAndComments } from "./python-source-text.js";

const FALLBACK_LOOKBACK_LINES = 30;

const KEYWORDS = new Set([
  "False", "None", "True", "and", "as", "assert", "async", "await", "break", "class", "continue", "def", "del",
  "elif", "else", "except", "finally", "for", "from", "global", "if", "import", "in", "is", "lambda", "nonlocal",
  "not", "or", "pass", "raise", "return", "try", "while", "with", "yield", "self", "cls",
]);

// A name that is not an attribute (so `user` in `user.email`, not `email`).
const IDENTIFIER = /(?<![\w.])[A-Za-z_]\w*/g;
// `name(`, `module.name(` or `self.name(`: calls vika can follow one step.
const CALLED_NAME = /(?<![\w.])([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?)\s*\(/g;
// `x = ...`, `x: Type = ...` and `a, b = ...` (not `==`).
const ASSIGNMENT = /^\s*([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s*(?::[^=]*)?=(?!=)\s*(.*)$/;
const DIRECT_CALL_START = /^(?:await\s+)?([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?)\s*\(/;

function readAssignedNames(code: string): string[] {
  const assignmentMatch = ASSIGNMENT.exec(code);
  if (!assignmentMatch) return [];
  return assignmentMatch[1]!.split(",").map((name) => name.trim()).filter((name) => !KEYWORDS.has(name));
}

function findReadNames(code: string): Set<string> {
  const assignedNames = new Set(readAssignedNames(code));
  const valueCode = assignedNames.size > 0 ? ASSIGNMENT.exec(code)![2]! : code;
  const readNames = new Set<string>();
  for (const identifierMatch of valueCode.matchAll(IDENTIFIER)) {
    const name = identifierMatch[0];
    if (!KEYWORDS.has(name)) readNames.add(name);
  }
  return readNames;
}

// The Python version of findCrashLineInputs: the lines above the crash line
// (inside the same function) that set a name the crash line reads, and the
// functions whose result it reads. One step only, like JavaScript.
export function findPythonCrashLineInputs(fileContent: string, crashLineNumber: number, functionName: string | undefined): CrashLineInputs {
  const fileLines = fileContent.split("\n");
  const crashIndex = crashLineNumber - 1;
  const crashLine = fileLines[crashIndex];
  if (crashLine === undefined) return { inputLineNumbers: [], calleeNames: [] };

  const crashCode = removePythonStringsAndComments(crashLine);
  const readNames = findReadNames(crashCode);
  const calleeNames = new Set<string>();
  for (const callMatch of crashCode.matchAll(CALLED_NAME)) {
    if (!KEYWORDS.has(callMatch[1]!)) calleeNames.add(callMatch[1]!);
  }

  const functionRange = functionName === undefined ? undefined : findPythonFunctionLineRange(fileContent, functionName, crashLineNumber);
  const firstIndex = functionRange === undefined ? Math.max(0, crashIndex - FALLBACK_LOOKBACK_LINES) : functionRange.startLine;

  const inputLineNumbers: number[] = [];
  for (let lineIndex = firstIndex; lineIndex < crashIndex; lineIndex++) {
    const code = removePythonStringsAndComments(fileLines[lineIndex]!);
    const assignedNames = readAssignedNames(code);
    if (!assignedNames.some((name) => readNames.has(name))) continue;
    inputLineNumbers.push(lineIndex + 1);
    const calleeName = DIRECT_CALL_START.exec(ASSIGNMENT.exec(code)![2]!.trim())?.[1];
    if (calleeName !== undefined && !KEYWORDS.has(calleeName)) calleeNames.add(calleeName);
  }

  return { inputLineNumbers, calleeNames: [...calleeNames].sort() };
}
