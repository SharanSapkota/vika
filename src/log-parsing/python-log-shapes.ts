import { normalizeLevel } from "./log-levels.js";
import type { LineStart } from "./log-entry-types.js";
import { toIso } from "./timestamps.js";








const GUNICORN_LINE = /^\[(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{4})\] \[\d+\] \[([A-Za-z]+)\] ?(.*)$/;
const PYTHON_LOGGER_LINE = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}),(\d{3}) - (\S+) - ([A-Za-z]+) - ?(.*)$/;



const PYTHON_LEVEL_WORDS = new Set(["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"]);

function buildLineStart(timestamp: string | undefined, levelWord: string, message: string): LineStart {
  if (timestamp === undefined || !PYTHON_LEVEL_WORDS.has(levelWord)) return { kind: "bad" };
  
  const level = normalizeLevel(levelWord);
  if (level === undefined) return { kind: "bad" };
  if (level === null) return { kind: "drop", timestamp };
  return { kind: "entry", timestamp, level, message };
}

export function readPythonShapeStart(line: string): LineStart {
  const gunicornMatch = GUNICORN_LINE.exec(line);
  if (gunicornMatch) {
    const [, date, time, zone, levelWord = "", message = ""] = gunicornMatch;
    return buildLineStart(toIso(`${date}T${time}${zone}`), levelWord, message);
  }

  const loggerMatch = PYTHON_LOGGER_LINE.exec(line);
  if (loggerMatch) {
    const [, date, time, milliseconds, , levelWord = "", message = ""] = loggerMatch;
    
    
    return buildLineStart(toIso(`${date}T${time}.${milliseconds}Z`), levelWord, message);
  }

  return { kind: "none" };
}
