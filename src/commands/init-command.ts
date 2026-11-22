


import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { detectProject, type DetectionReaders, type ProjectDetection } from "../project-setup/detect-project.js";
import { buildStarterEnvironmentExample, buildStarterVikaYaml, NEXT_STEPS } from "../project-setup/write-starter-files.js";

export const STARTER_FILE_NAMES = ["vika.yaml", ".env.example"] as const;

export interface InitCommandOptions {
  directory: string;
  logFolders?: string[]; 
  readers?: DetectionReaders;
}

export type InitCommandResult =
  | { status: "written"; writtenFiles: string[]; detection: ProjectDetection; nextSteps: string }
  | { status: "refused"; existingFiles: string[] };

export async function runInitCommand(options: InitCommandOptions): Promise<InitCommandResult> {
  const directory = resolve(options.directory);
  const targetPaths = STARTER_FILE_NAMES.map((fileName) => join(directory, fileName));
  const existingFiles = targetPaths.filter((targetPath) => existsSync(targetPath));
  if (existingFiles.length > 0) return { status: "refused", existingFiles };

  const detection = await detectProject(directory, options.logFolders, options.readers);
  const contents = [buildStarterVikaYaml(detection), buildStarterEnvironmentExample()];
  
  targetPaths.forEach((targetPath, fileIndex) => writeFileSync(targetPath, contents[fileIndex]!, { flag: "wx" }));
  return { status: "written", writtenFiles: targetPaths, detection, nextSteps: NEXT_STEPS };
}
