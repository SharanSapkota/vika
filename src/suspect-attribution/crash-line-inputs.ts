import { isFunctionDefinitionLine } from "./function-names.js";

const FALLBACK_LOOKBACK_LINES = 30;
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
  inputLineNumbers: number[];
  calleeNames: string[];
}

function removeStringsAndComments(line: string): string {
  return line.replace(/(["'`])(?:\\.|(?!\1)[^\\])*\1/g, '""').replace(/\/\/.*$/, "");
}

function findReadNames(code: string): Set<string> {
  const declaredName = /^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/.exec(code)?.[1];
  const readNames = new Set<string>();
  for (const identifierMatch of code.matchAll(IDENTIFIER)) {
    const name = identifierMatch[0];
    if (!KEYWORDS.has(name) && name !== declaredName) readNames.add(name);
  }
  return readNames;
}

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
  for (let lineIndex = functionStartIndex + 1; lineIndex < crashIndex; lineIndex++) {
    const assignmentMatch = ASSIGNMENT.exec(removeStringsAndComments(fileLines[lineIndex]!));
    if (!assignmentMatch || !readNames.has(assignmentMatch[1]!)) continue;
    inputLineNumbers.push(lineIndex + 1);
    const calleeName = DIRECT_CALL_START.exec(assignmentMatch[2]!.trim())?.[1];
    if (calleeName !== undefined && !KEYWORDS.has(calleeName)) calleeNames.add(calleeName);
  }

  return { inputLineNumbers, calleeNames: [...calleeNames].sort() };
}
