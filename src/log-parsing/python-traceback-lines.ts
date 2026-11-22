









export const TRACEBACK_START = "Traceback (most recent call last):";


export const CHAIN_MARKERS = new Set([
  "During handling of the above exception, another exception occurred:",
  "The above exception was the direct cause of the following exception:",
]);

export const isIndented = (line: string) => /^\s/.test(line);


type TracebackPosition = "waiting-for-traceback" | "inside-traceback" | "after-exception-line" | "not-a-traceback";

function nextPosition(position: TracebackPosition, line: string): TracebackPosition {
  
  if (line.trim() === "") return position;
  const trimmedLine = line.trim();
  if (position === "waiting-for-traceback") return trimmedLine === TRACEBACK_START ? "inside-traceback" : "not-a-traceback";
  if (position === "inside-traceback") {
    
    
    return isIndented(line) ? "inside-traceback" : "after-exception-line";
  }
  if (position === "after-exception-line") return CHAIN_MARKERS.has(trimmedLine) ? "waiting-for-traceback" : "not-a-traceback";
  return "not-a-traceback";
}




export function isPythonTracebackLine(line: string, attachedLines: readonly string[]): boolean {
  let position: TracebackPosition = "waiting-for-traceback";
  for (const attachedLine of attachedLines) position = nextPosition(position, attachedLine);
  return nextPosition(position, line) !== "not-a-traceback";
}
