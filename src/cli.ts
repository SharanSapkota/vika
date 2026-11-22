#!/usr/bin/env node
// The `vika` executable. The only place that touches the real process:
// its arguments, input and output, environment, network and the clock.
import { createInterface } from "node:readline/promises";
import { runCli } from "./commands/run-cli.js";

process.exitCode = await runCli(process.argv.slice(2), {
  writeOutput: (text) => process.stdout.write(text),
  writeError: (text) => process.stderr.write(text),
  isOutputTerminal: process.stdout.isTTY === true,
  isInputTerminal: process.stdin.isTTY === true,
  // Questions go to stderr, so they never mix into --json output.
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
  // Ctrl+C (or a service manager's stop) ends `serve` cleanly: the server and
  // the database pool are closed before vika exits.
  waitForStopSignal: () =>
    new Promise<void>((resolve) => {
      process.once("SIGINT", () => resolve());
      process.once("SIGTERM", () => resolve());
    }),
});
