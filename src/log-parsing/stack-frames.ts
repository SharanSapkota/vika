import type { Frame } from "./log-entry-types.js";
import type { StackTraceReading } from "./stack-trace-reading.js";

const STACK_FRAME_LINE = /^\s*at\s+(?:(.+?)\s+\((.+):(\d+):\d+\)|(.+):(\d+):\d+)\s*$/;

export function parseFrame(line: string): Frame | undefined {
  const frameMatch = STACK_FRAME_LINE.exec(line);
  if (!frameMatch) return undefined;
  if (frameMatch[2] !== undefined) return { fn: frameMatch[1] as string, file: frameMatch[2], line: Number(frameMatch[3]) };
  return { file: frameMatch[4] as string, line: Number(frameMatch[5]) };
}



export function readJavascriptStackTrace(stackTraceLines: string[]): StackTraceReading {
  const frames: Frame[] = [];
  const messageLines: string[] = [];
  for (const line of stackTraceLines) {
    const frame = parseFrame(line);
    if (frame) frames.push(frame);
    else if (!/^\s*at\s/.test(line) && line.trim() !== "") messageLines.push(line.trim());
  }
  return { frames, messageLines };
}
