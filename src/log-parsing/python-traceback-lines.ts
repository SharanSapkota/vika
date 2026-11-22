// What each line of a Python traceback is, and which lines may follow which.
// Used both to attach traceback lines to the log entry above them and to
// read the traceback afterwards, so the two always agree.
//
//   Traceback (most recent call last):
//     File "/app/src/shop/orders/service.py", line 14, in create_order
//       email = user.email
//               ^^^^^^^^^^
//   AttributeError: 'NoneType' object has no attribute 'email'

export const TRACEBACK_START = "Traceback (most recent call last):";

// The lines Python prints between two tracebacks of one chained exception.
export const CHAIN_MARKERS = new Set([
  "During handling of the above exception, another exception occurred:",
  "The above exception was the direct cause of the following exception:",
]);

export const isIndented = (line: string) => /^\s/.test(line);

// Where the reader is in a traceback, after the lines attached so far.
type TracebackPosition = "waiting-for-traceback" | "inside-traceback" | "after-exception-line" | "not-a-traceback";

function nextPosition(position: TracebackPosition, line: string): TracebackPosition {
  // Blank lines appear around chain markers; they never change anything.
  if (line.trim() === "") return position;
  const trimmedLine = line.trim();
  if (position === "waiting-for-traceback") return trimmedLine === TRACEBACK_START ? "inside-traceback" : "not-a-traceback";
  if (position === "inside-traceback") {
    // Frame lines, source lines and Python 3.11+ "^^^^" lines are indented.
    // The first line that is not indented is the exception line.
    return isIndented(line) ? "inside-traceback" : "after-exception-line";
  }
  if (position === "after-exception-line") return CHAIN_MARKERS.has(trimmedLine) ? "waiting-for-traceback" : "not-a-traceback";
  return "not-a-traceback";
}

// True when `line` continues the traceback made of `attachedLines`. Anything
// else, such as a Python warning or its indented source line, is not
// attached, so it can never end up in an error message.
export function isPythonTracebackLine(line: string, attachedLines: readonly string[]): boolean {
  let position: TracebackPosition = "waiting-for-traceback";
  for (const attachedLine of attachedLines) position = nextPosition(position, attachedLine);
  return nextPosition(position, line) !== "not-a-traceback";
}
