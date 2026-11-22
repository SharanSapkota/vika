// Guesses a log's format from a sample of its lines.
import { LINE_START_READERS } from "./line-readers.js";
import type { LogFormat } from "./log-entry-types.js";

// How many sample lines the best format recognizes, so callers can tell
// "text" (recognized) from "text" (the fallback because nothing matched).
export function recognizeFormat(sampleLines: string[]): { format: LogFormat; recognizedCount: number } {
  const format = detectFormat(sampleLines);
  let recognizedCount = 0;
  for (const line of sampleLines) {
    try {
      const kind = LINE_START_READERS[format](line).kind;
      if (kind === "entry" || kind === "drop") recognizedCount++;
    } catch {
      // an unreadable line just doesn't count
    }
  }
  return { format, recognizedCount };
}

// Whichever format recognizes the most lines wins. Ties, or nothing
// recognized at all, fall back to "text".
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
        // an unreadable line just doesn't count
      }
    }
    if (score > bestScore) {
      bestFormat = format;
      bestScore = score;
    }
  }
  return bestFormat;
}
