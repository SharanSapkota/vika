// The shapes every log format parser shares.

export type Level = "ERROR" | "WARN";

// `fn` keeps its short name: frames are stored as JSON in the database
// (top_frames), so renaming it would change stored data.
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

// What a format's line reader says about one line.
export type LineStart =
  | { kind: "entry"; timestamp: string; level: Level; message: string; stack?: string }
  | { kind: "drop"; timestamp: string } // a fine line, but a level we don't keep (INFO, DEBUG, ...)
  | { kind: "bad" } // looks like a log line but is broken: counted as skipped
  | { kind: "none" }; // not the start of an entry (maybe a stack trace line)
