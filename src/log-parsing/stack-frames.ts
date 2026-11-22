import type { Frame } from "./log-entry-types.js";

const STACK_FRAME_LINE = /^\s*at\s+(?:(.+?)\s+\((.+):(\d+):\d+\)|(.+):(\d+):\d+)\s*$/;

export function parseFrame(line: string): Frame | undefined {
  const frameMatch = STACK_FRAME_LINE.exec(line);
  if (!frameMatch) return undefined;
  if (frameMatch[2] !== undefined) return { fn: frameMatch[1] as string, file: frameMatch[2], line: Number(frameMatch[3]) };
  return { file: frameMatch[4] as string, line: Number(frameMatch[5]) };
}
