// The timestamp of one line in any format. Used by the command reader to
// drop lines it has already seen.
import { LINE_START_READERS } from "./line-readers.js";
import { toIso } from "./timestamps.js";

// undefined for lines without a time (e.g. stack trace lines).
export function lineTimestamp(line: string): string | undefined {
  for (const readLineStart of Object.values(LINE_START_READERS)) {
    try {
      const lineStart = readLineStart(line);
      if (lineStart.kind === "entry" || lineStart.kind === "drop") return lineStart.timestamp;
    } catch {
      // try the next format
    }
  }
  // A timestamped line with a level we don't know still has a time.
  const timestampMatch = /^(\S+(?: \d{2}:\d{2}:\d{2}\S*)?)/.exec(line);
  return timestampMatch?.[1] ? toIso(timestampMatch[1]) : undefined;
}
