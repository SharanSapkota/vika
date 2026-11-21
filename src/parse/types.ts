
export type Level = "ERROR" | "WARN";

export interface Frame {
  file: string;
  line: number;
  fn?: string;
}

export interface LogEntry {
  timestamp: string; // ISO, always UTC ("...Z")
  level: Level;
  message: string; // may span several lines (e.g. "request failed\nTypeError: ...")
  frames: Frame[]; // top frame first
  file?: string; // copied from the top frame
  lineNumber?: number; // copied from the top frame
}

// What every format parser returns.
export interface ParseResult {
  entries: LogEntry[];
  skipped: number; // lines we could not make sense of
}

export type LogFormat = "json" | "text" | "nginx";
