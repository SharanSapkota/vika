import { open } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { LogsSetting } from "../configuration/configuration-schema.js";
import { recognizeFormat } from "../log-parsing/detect-log-format.js";
import { parseLines } from "../log-parsing/parse-log-lines.js";
import { readCommand } from "../log-parsing/read-log-command.js";
import type { PathMap } from "../suspect-attribution/suspect-types.js";
import { failCheck, passCheck, warnCheck, type DoctorCheck } from "./doctor-check-types.js";
import { adviseOnPathMap } from "./suggest-path-map.js";

export const DOCTOR_COMMAND_TIMEOUT_MS = 10_000;
export const SAMPLE_LINE_COUNT = 200;
const SAMPLE_BYTES = 256 * 1024;
const GLOB_CHARACTERS = /[*?[\]{}]/;

export interface LogsCheckInput {
  serviceName: string;
  logs: LogsSetting;
  configurationDirectory: string;
  pathMap: PathMap | undefined;
  doesRepoFileExist: ((repoPath: string) => Promise<boolean>) | undefined;
  commandTimeoutMs?: number;
}

async function readFileSample(filePath: string): Promise<{ firstLines: string[]; lastLines: string[] }> {
  const handle = await open(filePath, "r");
  try {
    const { size } = await handle.stat();
    const readBytes = async (position: number) => {
      const buffer = Buffer.alloc(Math.min(SAMPLE_BYTES, size));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      return buffer.subarray(0, bytesRead).toString("utf8").split("\n");
    };
    const firstLines = (await readBytes(0)).slice(0, SAMPLE_LINE_COUNT);
    const lastLines = size > SAMPLE_BYTES ? (await readBytes(size - SAMPLE_BYTES)).slice(1) : [];
    return { firstLines, lastLines };
  } finally {
    await handle.close();
  }
}

export async function checkServiceLogs(input: LogsCheckInput): Promise<DoctorCheck[]> {
  const area = `service ${input.serviceName}: logs`;
  const settingName = `services.${input.serviceName}.logs`;
  const checks: DoctorCheck[] = [];
  let sampleLines: string[];
  let stackTraceLines: string[];

  if (typeof input.logs === "string") {
    if (GLOB_CHARACTERS.test(input.logs)) {
      return [warnCheck(area, `${settingName} is a glob pattern; globs are not supported yet, so no logs will be read`, `set ${settingName} to one log file`)];
    }
    const filePath = isAbsolute(input.logs) ? input.logs : resolve(input.configurationDirectory, input.logs);
    try {
      const fileSample = await readFileSample(filePath);
      sampleLines = fileSample.firstLines;
      stackTraceLines = [...fileSample.firstLines, ...fileSample.lastLines];
    } catch (error) {
      const reason = (error as NodeJS.ErrnoException).code === "ENOENT" ? "does not exist" : "cannot be read (check its permissions)";
      return [failCheck(area, `${filePath} ${reason}`, `set ${settingName} to the service's log file, readable by the user that runs vika`)];
    }
    checks.push(passCheck(area, `${filePath} is readable`));
  } else {
    const timeoutMs = input.commandTimeoutMs ?? DOCTOR_COMMAND_TIMEOUT_MS;
    let commandRead;
    try {
      commandRead = await readCommand(input.logs.command, undefined, timeoutMs);
    } catch {
      return [failCheck(area, "the log command could not be started", `check ${settingName}.command`)];
    }
    sampleLines = commandRead.lines.slice(0, SAMPLE_LINE_COUNT);
    stackTraceLines = commandRead.lines;
    if (commandRead.exitCode !== 0 && !commandRead.timedOut) {
      return [failCheck(area, `the log command exited with code ${commandRead.exitCode}`, `run it yourself to see why: ${input.logs.command}`)];
    }
    if (commandRead.lines.length === 0) {
      return [failCheck(area, `the log command printed nothing${commandRead.timedOut ? ` in ${timeoutMs / 1000} seconds` : ""}`, `run it yourself and check it prints log lines: ${input.logs.command}`)];
    }
    checks.push(
      commandRead.timedOut
        ? warnCheck(area, `the log command was still running after ${timeoutMs / 1000} seconds (it printed ${commandRead.lines.length} lines)`, "commands that follow the log forever (like tail -f or --follow) never finish; drop that flag")
        : passCheck(area, `the log command ran and printed ${commandRead.lines.length} lines`),
    );
  }

  const nonEmptyLines = sampleLines.filter((line) => line.trim() !== "");
  if (nonEmptyLines.length === 0) {
    checks.push(warnCheck(area, "the log is empty, so its format can't be checked yet", "run doctor again once the service has written some logs"));
    return checks;
  }
  const { format, recognizedCount } = recognizeFormat(nonEmptyLines);
  if (recognizedCount === 0) {
    checks.push(failCheck(area, `none of the first ${nonEmptyLines.length} lines is in a format vika knows (text, json, nginx)`, "see the README for the supported formats; most loggers can write one of them"));
    return checks;
  }
  checks.push(passCheck(area, `format: ${format} (${recognizedCount} of the first ${nonEmptyLines.length} lines recognized)`));

  if (input.doesRepoFileExist !== undefined) {
    const framePaths = parseLines(stackTraceLines, format).entries.flatMap((entry) => entry.frames.map((frame) => frame.file));
    const advice = await adviseOnPathMap(framePaths, input.pathMap, input.doesRepoFileExist);
    if (advice.kind === "no stack traces") checks.push(passCheck(area, "no stack traces in the sampled lines, so there are no file paths to check yet"));
    if (advice.kind === "paths found") checks.push(passCheck(area, `stack-trace paths match files in the repo (${advice.checkedCount} checked)`));
    if (advice.kind === "suggestion") {
      checks.push(
        warnCheck(
          area,
          `stack-trace paths like ${advice.examplePath} are not in the repo`,
          `add to services.${input.serviceName} in vika.yaml:  pathMap: { "${advice.serverPrefix}": "${advice.repoPrefix}" }`,
        ),
      );
    }
    if (advice.kind === "not found") {
      checks.push(warnCheck(area, `stack-trace paths like ${advice.examplePath} are not in the repo`, `add a pathMap to services.${input.serviceName} that turns them into repo paths`));
    }
  }
  return checks;
}
