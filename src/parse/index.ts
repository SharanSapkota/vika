// Turns log lines in each supported format into normalized entries.
import { toIso, type LineStart } from "./common.js";
import { parseJson, readJsonStart } from "./json.js";
import { parseNginx, readNginxLine } from "./nginx.js";
import { parseText, readTextStart } from "./text.js";
import type { LogFormat, ParseResult } from "./types.js";

export type { Frame, Level, LogEntry, LogFormat, ParseResult } from "./types.js";

const READERS: Record<LogFormat, (line: string) => LineStart> = {
  text: readTextStart,
  json: readJsonStart,
  nginx: readNginxLine,
};

const PARSERS: Record<LogFormat, (lines: string[]) => ParseResult> = {
  text: parseText,
  json: parseJson,
  nginx: parseNginx,
};

// Guesses the format from a sample: whichever format recognizes the most
// lines wins. Ties, or nothing recognized at all, fall back to "text".
export function detectFormat(sampleLines: string[]): LogFormat {
  let best: LogFormat = "text";
  let bestScore = 0;
  for (const format of ["text", "json", "nginx"] as const) {
    let score = 0;
    for (const line of sampleLines) {
      try {
        const kind = READERS[format](line).kind;
        if (kind === "entry" || kind === "drop") score++;
      } catch {
        // an unreadable line just doesn't count
      }
    }
    if (score > bestScore) {
      best = format;
      bestScore = score;
    }
  }
  return best;
}

// Parses lines in the given format, or detects it from the first 200 lines.
export function parseLines(lines: string[], format?: LogFormat): ParseResult & { format: LogFormat } {
  const used = format ?? detectFormat(lines.slice(0, 200));
  return { format: used, ...PARSERS[used](lines) };
}

// The timestamp of one line in any format, or undefined (e.g. stack trace lines).
// Used by the command reader to drop lines it has already seen.
export function lineTimestamp(line: string): string | undefined {
  for (const read of Object.values(READERS)) {
    try {
      const start = read(line);
      if (start.kind === "entry" || start.kind === "drop") return start.timestamp;
    } catch {
      // try the next format
    }
  }
  // A timestamped line with a level we don't know still has a time.
  const m = /^(\S+(?: \d{2}:\d{2}:\d{2}\S*)?)/.exec(line);
  return m?.[1] ? toIso(m[1]) : undefined;
}
