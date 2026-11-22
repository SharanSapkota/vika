import type { Frame } from "./log-entry-types.js";
import { CHAIN_MARKERS, isIndented, TRACEBACK_START } from "./python-traceback-lines.js";
import type { StackTraceReading } from "./stack-trace-reading.js";

const FRAME_LINE = /^\s+File "(.+)", line (\d+)(?:, in (.+?))?\s*$/;



const EXCEPTION_LINE = /^([A-Za-z_][\w.]*)(?::(?:\s|$)|$)/;


export function readPythonTraceback(tracebackLines: string[]): StackTraceReading {
  
  
  
  
  
  const lastStartIndex = tracebackLines.map((line) => line.trim()).lastIndexOf(TRACEBACK_START);
  const lastTraceback = lastStartIndex === -1 ? tracebackLines : tracebackLines.slice(lastStartIndex + 1);

  const framesOldestFirst: Frame[] = [];
  let exceptionLine: string | undefined;
  for (const line of lastTraceback) {
    const frameMatch = FRAME_LINE.exec(line);
    if (frameMatch) {
      const frame: Frame = { file: frameMatch[1]!, line: Number(frameMatch[2]) };
      if (frameMatch[3] !== undefined) frame.fn = frameMatch[3];
      framesOldestFirst.push(frame);
      continue;
    }
    
    if (isIndented(line) || line.trim() === "" || CHAIN_MARKERS.has(line.trim())) continue;
    exceptionLine ??= line.trim();
  }

  
  
  const reading: StackTraceReading = { frames: framesOldestFirst.reverse(), messageLines: exceptionLine === undefined ? [] : [exceptionLine] };
  const exceptionType = exceptionLine === undefined ? undefined : EXCEPTION_LINE.exec(exceptionLine)?.[1];
  if (exceptionType !== undefined) reading.exceptionType = exceptionType;
  return reading;
}
