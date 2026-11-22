import { z } from "zod";
import { REDACTION_KINDS } from "../redaction/redaction-kinds.js";

export const SERVICE_NAME_PATTERN = /^[a-z0-9-]+$/;
export const DEPLOY_SOURCES = ["merges", "marker", "logs-version", "github"] as const;

const requiredText = () => z.string({ error: "must be text" }).min(1, { error: "must not be empty" });

const logsSchema = z.union([requiredText(), z.strictObject({ command: requiredText() })], {
  error: 'must be a log file path (or glob), or { command: "..." } with the command that prints the logs',
});

const serviceSchema = z.strictObject(
  {
    repo: requiredText(), // path to the git checkout
    logs: logsSchema,
    pathMap: z.record(z.string(), z.string({ error: "must be text" }), { error: "must be a map of prefix: prefix" }).optional(),
    branch: requiredText().default("main"),
    pathPrefix: requiredText().optional(), // monorepo: the service lives under this folder
    deploys: z
      .strictObject({ source: z.enum(DEPLOY_SOURCES) }, { error: "must be { source: ... }" })
      .default(() => ({ source: "merges" as const })),
  },
  { error: "must be a map of settings (repo, logs, ...)" },
);

const trackerSchema = z
  .discriminatedUnion(
    "type",
    [
      z.strictObject({ type: z.literal("jira"), project: requiredText(), issueType: requiredText().default("Bug") }),
      z.strictObject({ type: z.literal("linear"), team: requiredText() }),
      z.strictObject({ type: z.literal("none") }),
    ],
    { error: 'must be "jira", "linear" or "none"' },
  )
  .default(() => ({ type: "none" as const }));

// Plain http would send regressions (and the signature) in the clear, so
// only https is allowed, except to this computer itself.
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

const webhookSchema = z.strictObject(
  {
    url: z.string({ error: "must be text" }).superRefine((text, context) => {
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(text);
      } catch {
        context.addIssue({ code: "custom", message: "must be a full URL, like https://hooks.example.com/vika" });
        return;
      }
      const isLocal = LOCAL_HOSTS.has(parsedUrl.hostname);
      if (parsedUrl.protocol !== "https:" && !(parsedUrl.protocol === "http:" && isLocal)) {
        context.addIssue({ code: "custom", message: "must use https (plain http is only allowed for localhost)" });
      }
    }),
    secret: z.undefined({ error: "must not be in vika.yaml: put it in .env as VIKA_WEBHOOK_SECRET" }).optional(),
  },
  { error: "must be { url: ... }" },
);

export const vikaYamlSchema = z.strictObject(
  {
    services: z
      .record(z.string().regex(SERVICE_NAME_PATTERN), serviceSchema, { error: "must be a map of service names to their settings" })
      .refine((services) => Object.keys(services).length > 0, { error: "must list at least one service" }),
    tracker: trackerSchema,
    redact: z
      .array(z.enum(REDACTION_KINDS), { error: "must be a list" })
      .min(1, { error: "must list at least one kind (email, jwt, ip, cardlike): redacting nothing is unsafe" })
      .default(() => [...REDACTION_KINDS]),
    webhook: webhookSchema.optional(),
  },
  { error: "must be a map of settings (services, tracker, redact, webhook)" },
);

export type VikaYaml = z.output<typeof vikaYamlSchema>;
export type ServiceSettings = VikaYaml["services"][string];
export type LogsSetting = ServiceSettings["logs"];
export type DeploySource = (typeof DEPLOY_SOURCES)[number];
export type TrackerSettings = VikaYaml["tracker"];
export type { RedactionKind } from "../redaction/redaction-kinds.js";
export type WebhookSettings = NonNullable<VikaYaml["webhook"]>;
