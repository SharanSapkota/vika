import type { Frame } from "./log-entry-types.js";

// What a language's stack-trace reader returns for the lines under one log
// entry: the frames (crashing call first), extra message lines (such as the
// exception line), and the exception's name when the reader knows it.
export interface StackTraceReading {
  frames: Frame[];
  messageLines: string[];
  exceptionType?: string;
}
