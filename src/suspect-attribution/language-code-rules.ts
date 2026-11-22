import type { Language } from "../log-parsing/languages.js";
import { findCalleeLocation, type CalleeLocation } from "./callee-files.js";
import { findCrashLineInputs, type CrashLineInputs } from "./crash-line-inputs.js";
import { findFunctionDefinitionLine, plainFunctionName } from "./function-names.js";
import { isPythonLibraryFrame } from "./library-frames.js";
import { findPythonCalleeLocation } from "./python-callee-files.js";
import { findPythonCrashLineInputs } from "./python-crash-line-inputs.js";
import {
  findPythonFunctionDefinitionLine,
  findPythonFunctionLineRange,
  readPythonFunctionName,
  type FunctionLineRange,
} from "./python-function-names.js";



export interface CodeRules {
  readPlainFunctionName(frameFunctionName: string | undefined): string | undefined;
  findFunctionDefinitionLine(fileContent: string, functionName: string): { lineNumber: number; lineText: string } | undefined;
  findCrashLineInputs(fileContent: string, crashLineNumber: number, functionName: string | undefined): CrashLineInputs;
  findCalleeLocation(fileContent: string, filePath: string, calleeName: string): CalleeLocation | undefined;
  
  isLibraryFrame(framePath: string): boolean;
  
  
  
  findFunctionLineRange: ((fileContent: string, functionName: string, lineNumberInside?: number) => FunctionLineRange | undefined) | null;
}

export const CODE_RULES: Record<Language, CodeRules> = {
  javascript: {
    readPlainFunctionName: plainFunctionName,
    findFunctionDefinitionLine,
    findCrashLineInputs,
    findCalleeLocation,
    isLibraryFrame: () => false,
    findFunctionLineRange: null,
  },
  python: {
    readPlainFunctionName: readPythonFunctionName,
    findFunctionDefinitionLine: findPythonFunctionDefinitionLine,
    findCrashLineInputs: findPythonCrashLineInputs,
    findCalleeLocation: findPythonCalleeLocation,
    isLibraryFrame: isPythonLibraryFrame,
    findFunctionLineRange: findPythonFunctionLineRange,
  },
};
