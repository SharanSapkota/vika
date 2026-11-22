import { redact } from "../redaction/redact-sensitive-text.js";
import { ALL_REDACTION_KINDS, type RedactionKind } from "../redaction/redaction-kinds.js";
import type { Frame, Level, LogEntry } from "./log-entry-types.js";
import { parseFrame } from "./stack-frames.js";

export interface EntryDraft {
  timestamp: string;
  level: Level;
  message: string;
  continuationLines: string[];
}

export function buildLogEntry(draft: EntryDraft, redactionKinds: readonly RedactionKind[] = ALL_REDACTION_KINDS): LogEntry {
  const frames: Frame[] = [];
  const messageLines = [draft.message.trim()];
  for (const line of draft.continuationLines) {
    const frame = parseFrame(line);
    if (frame) frames.push(frame);
    else if (!/^\s*at\s/.test(line) && line.trim() !== "") messageLines.push(line.trim());
  }
  const safeFrames = frames.map((frame) =>
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
  return entry;
}
