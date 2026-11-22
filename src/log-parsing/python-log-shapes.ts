import { normalizeLevel } from "./log-levels.js";
import type { LineStart } from "./log-entry-types.js";
import { toIso } from "./timestamps.js";

// The two line shapes a Python backend in Docker writes (gunicorn with
// uvicorn workers and a FastAPI app), read by the text format:
//
//   gunicorn / uvicorn:  [2026-11-21 19:17:52 +0000] [7] [INFO] Booting worker with pid: 7
//   the app's logger:    2026-11-21 19:17:57,987 - server - INFO - Cloudinary reachable
//
// Only these exact shapes are read; nothing else is guessed.
const GUNICORN_LINE = /^\[(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{4})\] \[\d+\] \[([A-Za-z]+)\] ?(.*)$/;
const PYTHON_LOGGER_LINE = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}),(\d{3}) - (\S+) - ([A-Za-z]+) - ?(.*)$/;

// Python's own level names. Any other word where the level belongs means the
// line only looks like one of these shapes, so it is counted as unreadable.
const PYTHON_LEVEL_WORDS = new Set(["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"]);

function buildLineStart(timestamp: string | undefined, levelWord: string, message: string): LineStart {
  if (timestamp === undefined || !PYTHON_LEVEL_WORDS.has(levelWord)) return { kind: "bad" };
  // WARNING becomes WARN and CRITICAL becomes ERROR; DEBUG and INFO are dropped.
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
    // The logger writes no time zone. The container clock is UTC, so the
    // time is read as UTC.
    return buildLineStart(toIso(`${date}T${time}.${milliseconds}Z`), levelWord, message);
  }

  return { kind: "none" };
}
