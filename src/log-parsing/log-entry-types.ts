
export type Level = "ERROR" | "WARN";

export interface Frame {
  file: string;
  line: number;
  fn?: string;
}

export interface LogEntry {
  timestamp: string;
  level: Level;
  message: string;
  frames: Frame[];
  file?: string;
  lineNumber?: number;
  // Set only when the stack-trace reader knows the exception's name for sure
  // (Python tracebacks). Otherwise grouping reads it from the message.
  exceptionType?: string;
}

export interface ParseResult {
  entries: LogEntry[];
  skipped: number;
}

export const LOG_FORMATS = ["text", "json", "nginx"] as const;

export type LogFormat = (typeof LOG_FORMATS)[number];

export type LineStart =
  | { kind: "entry"; timestamp: string; level: Level; message: string; stack?: string }
  | { kind: "drop"; timestamp: string }
  | { kind: "bad" }
  | { kind: "none" };
