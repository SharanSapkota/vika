import { buildLogEntry, type EntryDraft } from "./build-log-entry.js";
import { CONTINUATION_RULES } from "./continuation-rules.js";
import { DEFAULT_LANGUAGE, type Language } from "./languages.js";
import type { LineStart, LogEntry, ParseResult } from "./log-entry-types.js";
import { ALL_REDACTION_KINDS, type RedactionKind } from "../redaction/redaction-kinds.js";

export function assembleLogEntries(
  lines: string[],
  readLineStart: (line: string) => LineStart,
  redactionKinds: readonly RedactionKind[] = ALL_REDACTION_KINDS,
  language: Language = DEFAULT_LANGUAGE,
): ParseResult {
  const isContinuationLine = CONTINUATION_RULES[language];
  const entries: LogEntry[] = [];
  let skipped = 0;
  let currentEntry: EntryDraft | "ignored" | null = null;
  // Lines under an ignored entry (such as an INFO line) are swallowed, but
  // they are still kept here so the continuation rule knows where it is.
  let ignoredEntryLines: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.trim() === "") continue;

    let lineStart: LineStart;
    try {
      lineStart = readLineStart(line);
    } catch {
      lineStart = { kind: "bad" };
    }

    if (lineStart.kind === "none") {
      const attachedLines = currentEntry === "ignored" ? ignoredEntryLines : currentEntry?.continuationLines;
      if (attachedLines === undefined || !isContinuationLine(line, attachedLines)) skipped++;
      else attachedLines.push(line);
      continue;
    }

    if (currentEntry !== null && currentEntry !== "ignored") entries.push(buildLogEntry(currentEntry, redactionKinds, language));
    if (lineStart.kind === "entry") {
      currentEntry = {
        timestamp: lineStart.timestamp,
        level: lineStart.level,
        message: lineStart.message,
        continuationLines: lineStart.stack ? lineStart.stack.split("\n") : [],
      };
    } else {
      if (lineStart.kind === "bad") skipped++;
      currentEntry = "ignored";
      ignoredEntryLines = [];
    }
  }
  if (currentEntry !== null && currentEntry !== "ignored") entries.push(buildLogEntry(currentEntry, redactionKinds, language));
  return { entries, skipped };
}
