






import { resolve } from "node:path";
import { Command, CommanderError } from "commander";
import { describeConfigurationSafely } from "../configuration/describe-configuration-safely.js";
import type { StoreOptions } from "../database/store-types.js";
import { formatTerminalReport } from "../reporting/format-terminal-report.js";
import type { FetchFunction } from "../ticket-trackers/tracker-types.js";
import { formatDoctorReport } from "../doctor/format-doctor-report.js";
import { runCreateTicketsCommand } from "./create-tickets-command.js";
import { runExplainCommand } from "./explain-command.js";
import { runDoctorCommand } from "./doctor-command.js";
import { runInitCommand } from "./init-command.js";
import { parsePort, runServeCommand } from "./serve-command.js";
import { DEFAULT_DASHBOARD_PORT } from "../dashboard/dashboard-server.js";
import { runMarkDeployCommand } from "./mark-deploy-command.js";
import { runReportCommand } from "./report-command.js";
import { chooseRunExitCode, EXIT_CODE_BUSY, EXIT_CODE_OK } from "./run-exit-code.js";

export interface CliEnvironment {
  writeOutput: (text: string) => void;
  writeError: (text: string) => void;
  isOutputTerminal: boolean; 
  isInputTerminal: boolean; 
  ask: (question: string) => Promise<string>; 
  fetchFunction: FetchFunction; 
  environment: Record<string, string | undefined>;
  workingDirectory: string;
  clock: () => Date;
  storeOptions?: StoreOptions; 
  
  
  waitForStopSignal?: () => Promise<void>;
}

export async function runCli(argumentList: string[], cli: CliEnvironment): Promise<number> {
  const program = new Command();
  
  program
    .configureOutput({ writeOut: cli.writeOutput, writeErr: cli.writeError })
    .exitOverride()
    .name("vika")
    .description("Find error patterns that first appeared after a deploy and name the suspect commit/PR.")
    .version("0.0.0");

  const commonOptions = (configurationPath: string | undefined) => ({
    workingDirectory: cli.workingDirectory,
    environment: cli.environment,
    ...(configurationPath === undefined ? {} : { configurationPath }),
    ...(cli.storeOptions === undefined ? {} : { storeOptions: cli.storeOptions }),
  });

  
  
  let finishedExitCode = EXIT_CODE_OK;

  
  
  
  const runReportFlow = async (options: { config?: string; json?: boolean; createTickets?: boolean; explain?: boolean }, isRunCommand: boolean) => {
    
    const isExplainRequested = !isRunCommand && options.explain === true;
    const result = await runReportCommand({
      ...commonOptions(options.config),
      isExplainRequested,
      
      ...(isRunCommand ? { webhookFetchFunction: cli.fetchFunction } : {}),
    });
    const safeConfiguration = describeConfigurationSafely(result.configuration);
    
    const writeInfo = options.json ? cli.writeError : cli.writeOutput;
    writeInfo(`Configuration: ${safeConfiguration.configurationFilePath}\nDatabase: ${safeConfiguration.databaseUrl}\n`);
    for (const warning of safeConfiguration.warnings) writeInfo(`Warning: ${warning}\n`);
    for (const runNote of result.runNotes) writeInfo(`${runNote}\n`);
    if (result.webhookDeliveredCount > 0) writeInfo(`Webhook: posted ${result.webhookDeliveredCount} new ${result.webhookDeliveredCount === 1 ? "regression" : "regressions"}\n`);
    for (const webhookWarning of result.webhookWarnings) writeInfo(`Warning: ${webhookWarning}\n`);
    for (const serviceStatus of result.serviceStatuses) {
      if (serviceStatus.status === "failed") writeInfo(`FAILED ${serviceStatus.serviceName}: ${serviceStatus.message}\n`);
      if (serviceStatus.status === "busy") writeInfo(`BUSY ${serviceStatus.serviceName}: ${serviceStatus.message}\n`);
    }
    
    
    
    const printedReport = isExplainRequested
      ? await runExplainCommand({
          configuration: result.configuration,
          report: result.report,
          serviceInputs: result.serviceInputs,
          fetchFunction: cli.fetchFunction,
          explainConsole: { isInteractive: cli.isInputTerminal && cli.isOutputTerminal, write: writeInfo, ask: cli.ask },
        })
      : result.report;
    if (options.json) cli.writeOutput(`${JSON.stringify(printedReport, null, 2)}\n`);
    else cli.writeOutput(`\n${formatTerminalReport(printedReport, { useColor: cli.isOutputTerminal })}`);

    let hasTicketFailure = false;
    
    if (options.createTickets) {
      const ticketResults = await runCreateTicketsCommand({
        configuration: result.configuration,
        report: result.report,
        fetchFunction: cli.fetchFunction,
        
        approvalConsole: { isInteractive: cli.isInputTerminal && cli.isOutputTerminal, write: writeInfo, ask: cli.ask },
        ...(cli.storeOptions === undefined ? {} : { storeOptions: cli.storeOptions }),
      });
      hasTicketFailure = ticketResults.some((ticketResult) => ticketResult.outcome?.status === "failed");
    }
    const exitCode = chooseRunExitCode(result.serviceStatuses, hasTicketFailure);
    
    finishedExitCode = !isRunCommand && exitCode === EXIT_CODE_BUSY ? EXIT_CODE_OK : exitCode;
  };

  program
    .command("report")
    .description("Read new logs, find regressions after deploys and name suspects. Writes only to vika's own database.")
    .option("--config <path>", "path to vika.yaml (default: ./vika.yaml)")
    .option("--json", "print the report as JSON")
    .option("--create-tickets", "after the report, ask for approval and file one ticket per bad deploy")
    .option("--explain", "ask an AI for an opinion on each regression; shows the exact text and asks before sending (needs explain.enabled in vika.yaml)")
    .action((options: { config?: string; json?: boolean; createTickets?: boolean; explain?: boolean }) => runReportFlow(options, false));

  program
    .command("run")
    .description("Like report, built for cron: never asks without a terminal. Exit 0 ok, 1 failure, 2 busy.")
    .option("--config <path>", "path to vika.yaml (default: ./vika.yaml)")
    .option("--create-tickets", "file tickets after approval; without a terminal nothing is filed")
    .action((options: { config?: string; createTickets?: boolean }) => runReportFlow(options, true));

  program
    .command("serve")
    .description(
      "Show the dashboard in a browser. Listens on 127.0.0.1 only (never 0.0.0.0), so nothing outside this computer can reach it. " +
        "Shows stored data only: run `vika run` (e.g. on cron) for new data.",
    )
    .option("--config <path>", "path to vika.yaml (default: ./vika.yaml)")
    .option("--port <number>", "port on 127.0.0.1", String(DEFAULT_DASHBOARD_PORT))
    .action(async (options: { config?: string; port: string }) => {
      const running = await runServeCommand({ ...commonOptions(options.config), fetchFunction: cli.fetchFunction, port: parsePort(options.port) });
      cli.writeOutput(
        [
          `vika dashboard: ${running.dashboard.url}`,
          "Listening on 127.0.0.1 only: nothing outside this computer can reach it.",
          "It shows what is stored; run `vika run` on a schedule (cron) for new data.",
          "Press Ctrl+C to stop.",
          "",
        ].join("\n"),
      );
      try {
        await (cli.waitForStopSignal?.() ?? Promise.resolve());
      } finally {
        await running.stop();
        cli.writeOutput("Stopped.\n");
      }
    });

  program
    .command("doctor")
    .description("Check vika.yaml, the database, each service's repo, logs and deploys, and the tracker. Changes nothing.")
    .option("--config <path>", "path to vika.yaml (default: ./vika.yaml)")
    .action(async (options: { config?: string }) => {
      const result = await runDoctorCommand({
        workingDirectory: cli.workingDirectory,
        environment: cli.environment,
        fetchFunction: cli.fetchFunction,
        ...(options.config === undefined ? {} : { configurationPath: options.config }),
        ...(cli.storeOptions === undefined ? {} : { storeOptions: cli.storeOptions }),
      });
      cli.writeOutput(formatDoctorReport(result.checks));
      finishedExitCode = result.exitCode;
    });

  program
    .command("init")
    .description("Write a starter vika.yaml and .env.example from what vika can detect. Never overwrites.")
    .option("--directory <path>", "the project folder (default: the current folder)")
    .action(async (options: { directory?: string }) => {
      const result = await runInitCommand({ directory: resolve(cli.workingDirectory, options.directory ?? ".") });
      if (result.status === "refused") {
        cli.writeError(`vika: not writing anything: ${result.existingFiles.join(" and ")} already ${result.existingFiles.length === 1 ? "exists. Edit it, or move it" : "exist. Edit them, or move them"} away and run init again.\n`);
        finishedExitCode = 1;
        return;
      }
      const { detection } = result;
      cli.writeOutput(
        [
          ...result.writtenFiles.map((filePath) => `Wrote ${filePath}`),
          "",
          "Detected:",
          `  service name: ${detection.serviceName}`,
          `  git repository: ${detection.isGitRepo ? "yes" : "no (set repo in vika.yaml)"}`,
          `  default branch: ${detection.defaultBranch ?? "not detected (assumed main)"}`,
          `  log file: ${detection.logFiles[0]?.path ?? "not found (set logs in vika.yaml)"}`,
          `  log format: ${detection.logFormat ?? "not detected"}`,
          "",
          result.nextSteps,
          "",
        ].join("\n"),
      );
    });

  program
    .command("mark-deploy")
    .description("Record that a service went live at a commit.")
    .requiredOption("--service <name>", "service name from vika.yaml")
    .requiredOption("--sha <sha>", "full commit sha that went live")
    .option("--previous-sha <sha>", "the sha that was live before (default: the latest stored deploy)")
    .option("--time <iso>", "when it went live, e.g. 2026-03-06T14:00:00Z (default: now)")
    .option("--config <path>", "path to vika.yaml (default: ./vika.yaml)")
    .action(async (options: { service: string; sha: string; previousSha?: string; time?: string; config?: string }) => {
      const result = await runMarkDeployCommand({
        ...commonOptions(options.config),
        serviceName: options.service,
        sha: options.sha,
        ...(options.previousSha === undefined ? {} : { previousSha: options.previousSha }),
        ...(options.time === undefined ? {} : { time: options.time }),
        clock: cli.clock,
      });
      const { deploy } = result;
      cli.writeOutput(
        `${result.isNew ? "Saved" : "Already saved"}: ${deploy.service} deploy of ${deploy.sha} at ${deploy.time}` +
          ` (previous: ${deploy.previousSha ?? "none, a starting point"})\n`,
      );
    });

  try {
    await program.parseAsync(argumentList, { from: "user" });
    return finishedExitCode;
  } catch (error) {
    
    if (error instanceof CommanderError) return error.exitCode;
    cli.writeError(`vika: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
