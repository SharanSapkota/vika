// Tests docs/report-schema.md against the real zod schemas: the examples
// must validate, and every field the schemas define must be documented.
// If this fails after a code change, update the doc (and bump schemaVersion
// if a field was removed or changed meaning).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  changeFailureRateSchema,
  medianTimeToRestoreSchema,
  reportDeploySchema,
  reportRegressionSchema,
  reportSchema,
  serviceReportSchema,
  suspectSchema,
} from "../src/reporting/report-schema.js";
import { webhookPayloadSchema } from "../src/webhook/webhook-payload-schema.js";

const DOCUMENT = readFileSync(join(import.meta.dirname, "..", "docs", "report-schema.md"), "utf8");

// The ```json block right after <!-- example: name -->.
function readExample(name: string): unknown {
  const exampleMatch = new RegExp(`<!-- example: ${name} -->\\s*\`\`\`json\\n([\\s\\S]*?)\\n\`\`\``).exec(DOCUMENT);
  if (!exampleMatch) throw new Error(`docs/report-schema.md has no "${name}" example`);
  return JSON.parse(exampleMatch[1]!);
}

describe("docs/report-schema.md", () => {
  it("the report example validates against the report schema", () => {
    const parseResult = reportSchema.safeParse(readExample("report"));
    expect(parseResult.error?.issues).toBeUndefined();
    expect(parseResult.data!.schemaVersion).toBe(1);
  });

  it("the webhook example validates against the payload schema, and holds no email", () => {
    const example = readExample("webhook");
    expect(webhookPayloadSchema.safeParse(example).error?.issues).toBeUndefined();
    expect(JSON.stringify(example)).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
  });

  it("documents every field of every schema", () => {
    const schemas: z.ZodObject[] = [
      reportSchema,
      serviceReportSchema,
      reportDeploySchema,
      reportRegressionSchema,
      suspectSchema,
      webhookPayloadSchema,
    ];
    for (const schema of schemas) {
      for (const fieldName of Object.keys(schema.shape)) expect(DOCUMENT, `field ${fieldName}`).toContain(`\`${fieldName}\``);
    }
    for (const fieldName of Object.keys(changeFailureRateSchema.shape)) expect(DOCUMENT).toContain(`\`changeFailureRate.${fieldName}\``);
    for (const fieldName of Object.keys(medianTimeToRestoreSchema.shape)) expect(DOCUMENT).toContain(`\`medianTimeToRestore.${fieldName}\``);
  });

  it("states the versioning rule", () => {
    expect(DOCUMENT).toContain("`schemaVersion` changes only when a field is removed or its meaning changes.");
  });
});
