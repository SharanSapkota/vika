import type { Frame } from "./log-entry-types.js";




export interface StackTraceReading {
  frames: Frame[];
  messageLines: string[];
  exceptionType?: string;
}
