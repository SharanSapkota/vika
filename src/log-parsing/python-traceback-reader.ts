import type { Frame } from "./log-entry-types.js";
import { CHAIN_MARKERS, isIndented, TRACEBACK_START } from "./python-traceback-lines.js";
import type { StackTraceReading } from "./stack-trace-reading.js";

const FRAME_LINE = /^\s+File "(.+)", line (\d+)(?:, in (.+?))?\s*$/;

// "TypeError: ...", "KeyError: 'amount'", "app.errors.PaymentError: ...",
// or a bare name such as "StopIteration".
const EXCEPTION_LINE = /^([A-Za-z_][\w.]*)(?::(?:\s|$)|$)/;

// Reads the lines under a Python error log line. PURE.
export function readPythonTraceback(tracebackLines: string[]): StackTraceReading {
  // A chained exception prints several tracebacks, oldest first. Only the
  // LAST one is used: it is the exception that actually ended the request,
  // and its frames show where that happened. The earlier ones are causes
  // (for example the KeyError behind a wrapping HTTPException); using them
  // would group and blame by the cause instead of the failure people see.
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
    // Indented lines that are not frames are source lines or "^^^^" markers.
    if (isIndented(line) || line.trim() === "" || CHAIN_MARKERS.has(line.trim())) continue;
    exceptionLine ??= line.trim();
  }

  // Python prints the crashing call LAST. The rest of vika expects the
  // crashing call first (like JavaScript), so the order is reversed here.
  const reading: StackTraceReading = { frames: framesOldestFirst.reverse(), messageLines: exceptionLine === undefined ? [] : [exceptionLine] };
  const exceptionType = exceptionLine === undefined ? undefined : EXCEPTION_LINE.exec(exceptionLine)?.[1];
  if (exceptionType !== undefined) reading.exceptionType = exceptionType;
  return reading;
}
