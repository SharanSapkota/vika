import type { Language } from "./languages.js";
import { isPythonTracebackLine } from "./python-traceback-lines.js";

// A line without a time of its own belongs to the log entry above it only
// when it continues that entry's stack trace. `attachedLines` are the lines
// already attached to that entry.
export type ContinuationRule = (line: string, attachedLines: readonly string[]) => boolean;

// JavaScript: indented "at ..." lines, "SomethingError: ..." and "Caused by:".
const JAVASCRIPT_CONTINUATION_LINE = /^(?:\s|[\w$.]*(?:Error|Exception)(?::|$)|Caused by:)/;

export const CONTINUATION_RULES: Record<Language, ContinuationRule> = {
  javascript: (line) => JAVASCRIPT_CONTINUATION_LINE.test(line),
  python: isPythonTracebackLine,
};
