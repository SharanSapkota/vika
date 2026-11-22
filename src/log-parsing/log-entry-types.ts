
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
}

export interface ParseResult {
  entries: LogEntry[];
  skipped: number;
}

export type LogFormat = "json" | "text" | "nginx";

export type LineStart =
  | { kind: "entry"; timestamp: string; level: Level; message: string; stack?: string }
  | { kind: "drop"; timestamp: string }
  | { kind: "bad" }
  | { kind: "none" };
