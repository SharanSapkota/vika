import type { Language } from "./languages.js";
import { readPythonTraceback } from "./python-traceback-reader.js";
import { readJavascriptStackTrace } from "./stack-frames.js";
import type { StackTraceReading } from "./stack-trace-reading.js";



export const STACK_TRACE_READERS: Record<Language, (stackTraceLines: string[]) => StackTraceReading> = {
  javascript: readJavascriptStackTrace,
  python: readPythonTraceback,
};
