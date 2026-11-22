#!/usr/bin/env node


import { createInterface } from "node:readline/promises";
import { runCli } from "./commands/run-cli.js";

process.exitCode = await runCli(process.argv.slice(2), {
  writeOutput: (text) => process.stdout.write(text),
  writeError: (text) => process.stderr.write(text),
  isOutputTerminal: process.stdout.isTTY === true,
  isInputTerminal: process.stdin.isTTY === true,
  
  ask: async (question) => {
    const lineReader = createInterface({ input: process.stdin, output: process.stderr });
    try {
      return await lineReader.question(question);
    } finally {
      lineReader.close();
    }
  },
  fetchFunction: (url, init) => fetch(url, init),
  environment: process.env,
  workingDirectory: process.cwd(),
  clock: () => new Date(),
  
  
  waitForStopSignal: () =>
    new Promise<void>((resolve) => {
      process.once("SIGINT", () => resolve());
      process.once("SIGTERM", () => resolve());
    }),
});
