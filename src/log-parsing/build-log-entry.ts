import { redact } from "../redaction/redact-sensitive-text.js";
import { ALL_REDACTION_KINDS, type RedactionKind } from "../redaction/redaction-kinds.js";
import { DEFAULT_LANGUAGE, type Language } from "./languages.js";
import type { Level, LogEntry } from "./log-entry-types.js";
import { STACK_TRACE_READERS } from "./stack-trace-readers.js";

export interface EntryDraft {
  timestamp: string;
  level: Level;
  message: string;
  continuationLines: string[];
}

export function buildLogEntry(
  draft: EntryDraft,
  redactionKinds: readonly RedactionKind[] = ALL_REDACTION_KINDS,
  language: Language = DEFAULT_LANGUAGE,
): LogEntry {
  const stackTrace = STACK_TRACE_READERS[language](draft.continuationLines);
  const messageLines = [draft.message.trim(), ...stackTrace.messageLines];
  const safeFrames = stackTrace.frames.map((frame) =>
    frame.fn === undefined
      ? { file: redact(frame.file, redactionKinds), line: frame.line }
      : { file: redact(frame.file, redactionKinds), line: frame.line, fn: redact(frame.fn, redactionKinds) },
  );
  const entry: LogEntry = {
    timestamp: draft.timestamp,
    level: draft.level,
    message: redact(messageLines.filter((messageLine) => messageLine !== "").join("\n"), redactionKinds),
    frames: safeFrames,
  };
  const topFrame = safeFrames[0];
  if (topFrame) {
    entry.file = topFrame.file;
    entry.lineNumber = topFrame.line;
  }
  if (stackTrace.exceptionType !== undefined) entry.exceptionType = redact(stackTrace.exceptionType, redactionKinds);
  return entry;
}
