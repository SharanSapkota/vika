import { LINE_START_READERS } from "./line-readers.js";
import { toIso } from "./timestamps.js";

export function lineTimestamp(line: string): string | undefined {
  for (const readLineStart of Object.values(LINE_START_READERS)) {
    try {
      const lineStart = readLineStart(line);
      if (lineStart.kind === "entry" || lineStart.kind === "drop") return lineStart.timestamp;
    } catch {
    }
  }
  const timestampMatch = /^(\S+(?: \d{2}:\d{2}:\d{2}\S*)?)/.exec(line);
  return timestampMatch?.[1] ? toIso(timestampMatch[1]) : undefined;
}
