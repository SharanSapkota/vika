// What `vika init` can learn about a project folder on its own: is it a git
// repo, what is the default branch, where are the logs, and what format are
// they in. The readers (git, folder listing, file sampling) are passed in,
// so tests can point them at temp folders.
import { readdirSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { basename, join } from "node:path";
import { runGit } from "../deploys/run-git.js";
import { recognizeFormat } from "../log-parsing/detect-log-format.js";
import type { LogFormat } from "../log-parsing/log-entry-types.js";

export interface LogFileCandidate {
  path: string;
  modifiedMs: number;
}

export interface DetectionReaders {
  runGit: (directory: string, gitArguments: string[]) => Promise<{ exitCode: number; stdout: string }>;
  listLogFiles: (folder: string) => LogFileCandidate[]; // *.log files in the folder; none if it doesn't exist
  readFirstLines: (filePath: string, lineCount: number) => Promise<string[]>;
}

export interface ProjectDetection {
  directory: string;
  serviceName: string;
  isGitRepo: boolean;
  defaultBranch: string | null; // null: not detected
  logFiles: LogFileCandidate[]; // newest first
  logFormat: LogFormat | null; // null: no log found, or no line recognized
}

const SAMPLE_LINE_COUNT = 50;
const SAMPLE_BYTES = 64 * 1024;

export const defaultDetectionReaders: DetectionReaders = {
  runGit: (directory, gitArguments) => runGit(directory, gitArguments),
  listLogFiles(folder) {
    try {
      return readdirSync(folder)
        .filter((fileName) => fileName.endsWith(".log"))
        .map((fileName) => join(folder, fileName))
        .filter((filePath) => statSync(filePath).isFile())
        .map((filePath) => ({ path: filePath, modifiedMs: statSync(filePath).mtimeMs }));
    } catch {
      return []; // the folder doesn't exist or can't be read
    }
  },
  async readFirstLines(filePath, lineCount) {
    const handle = await open(filePath, "r");
    try {
      const buffer = Buffer.alloc(SAMPLE_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, SAMPLE_BYTES, 0);
      return buffer.subarray(0, bytesRead).toString("utf8").split("\n").slice(0, lineCount);
    } finally {
      await handle.close();
    }
  },
};

// Where logs usually are: ./logs and /var/log/<folder name>.
export function defaultLogFolders(directory: string): string[] {
  return [join(directory, "logs"), join("/var/log", basename(directory))];
}

// A service name from the folder name: lowercase letters, digits and dashes.
export function makeServiceName(directory: string): string {
  const serviceName = basename(directory)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
  return serviceName === "" ? "app" : serviceName;
}

async function detectDefaultBranch(readers: DetectionReaders, directory: string): Promise<string | null> {
  // The remote's default branch ("origin/main"), else the branch checked out.
  const remoteDefault = await readers.runGit(directory, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  if (remoteDefault.exitCode === 0 && remoteDefault.stdout.trim() !== "") return remoteDefault.stdout.trim().replace(/^origin\//, "");
  const currentBranch = await readers.runGit(directory, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (currentBranch.exitCode === 0 && currentBranch.stdout.trim() !== "") return currentBranch.stdout.trim();
  return null;
}

export async function detectProject(
  directory: string,
  logFolders: string[] = defaultLogFolders(directory),
  readers: DetectionReaders = defaultDetectionReaders,
): Promise<ProjectDetection> {
  const insideWorkTree = await readers.runGit(directory, ["rev-parse", "--is-inside-work-tree"]).catch(() => ({ exitCode: 1, stdout: "" }));
  const isGitRepo = insideWorkTree.exitCode === 0 && insideWorkTree.stdout.trim() === "true";
  const defaultBranch = isGitRepo ? await detectDefaultBranch(readers, directory) : null;

  const logFiles = logFolders.flatMap((folder) => readers.listLogFiles(folder)).sort((left, right) => right.modifiedMs - left.modifiedMs);
  let logFormat: LogFormat | null = null;
  const newestLogFile = logFiles[0];
  if (newestLogFile !== undefined) {
    const sampleLines = (await readers.readFirstLines(newestLogFile.path, SAMPLE_LINE_COUNT)).filter((line) => line.trim() !== "");
    const recognition = recognizeFormat(sampleLines);
    if (recognition.recognizedCount > 0) logFormat = recognition.format;
  }

  return { directory, serviceName: makeServiceName(directory), isGitRepo, defaultBranch, logFiles, logFormat };
}
