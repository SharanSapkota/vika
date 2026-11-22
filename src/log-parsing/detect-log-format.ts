import { LINE_START_READERS } from "./line-readers.js";
import type { LogFormat } from "./log-entry-types.js";

export function recognizeFormat(sampleLines: string[]): { format: LogFormat; recognizedCount: number } {
  const format = detectFormat(sampleLines);
  let recognizedCount = 0;
  for (const line of sampleLines) {
    try {
      const kind = LINE_START_READERS[format](line).kind;
      if (kind === "entry" || kind === "drop") recognizedCount++;
    } catch {
    }
  }
  return { format, recognizedCount };
}

export function detectFormat(sampleLines: string[]): LogFormat {
  let bestFormat: LogFormat = "text";
  let bestScore = 0;
  for (const format of ["text", "json", "nginx"] as const) {
    let score = 0;
    for (const line of sampleLines) {
      try {
        const kind = LINE_START_READERS[format](line).kind;
        if (kind === "entry" || kind === "drop") score++;
      } catch {
      }
    }
    if (score > bestScore) {
      bestFormat = format;
      bestScore = score;
    }
  }
  return bestFormat;
}
