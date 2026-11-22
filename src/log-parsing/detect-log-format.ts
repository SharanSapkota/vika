import { LINE_START_READERS } from "./line-readers.js";
import { LOG_FORMATS, type LogFormat } from "./log-entry-types.js";


export function countRecognizedLines(sampleLines: string[], format: LogFormat): number {
  let recognizedCount = 0;
  for (const line of sampleLines) {
    try {
      const kind = LINE_START_READERS[format](line).kind;
      if (kind === "entry" || kind === "drop") recognizedCount++;
    } catch {
    }
  }
  return recognizedCount;
}

export function recognizeFormat(sampleLines: string[]): { format: LogFormat; recognizedCount: number } {
  const format = detectFormat(sampleLines);
  return { format, recognizedCount: countRecognizedLines(sampleLines, format) };
}

export function detectFormat(sampleLines: string[]): LogFormat {
  let bestFormat: LogFormat = "text";
  let bestScore = 0;
  for (const format of LOG_FORMATS) {
    const score = countRecognizedLines(sampleLines, format);
    if (score > bestScore) {
      bestFormat = format;
      bestScore = score;
    }
  }
  return bestFormat;
}
