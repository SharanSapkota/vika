import type { Language } from "./languages.js";
import { isPythonTracebackLine } from "./python-traceback-lines.js";




export type ContinuationRule = (line: string, attachedLines: readonly string[]) => boolean;


const JAVASCRIPT_CONTINUATION_LINE = /^(?:\s|[\w$.]*(?:Error|Exception)(?::|$)|Caused by:)/;

export const CONTINUATION_RULES: Record<Language, ContinuationRule> = {
  javascript: (line) => JAVASCRIPT_CONTINUATION_LINE.test(line),
  python: isPythonTracebackLine,
};
