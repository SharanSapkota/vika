// One ticket draft per bad deploy in a report. Reads the stored clusters
// (for redacted examples and log sources) and the repo's CODEOWNERS at the
// deployed sha (read-only git). Deploys with no medium or high regression
// give no draft.
import type { LoadedConfiguration } from "../configuration/load-configuration.js";
import type { Store } from "../database/store-types.js";
import type { Report } from "../reporting/report-types.js";
import { buildTicketDraft, rankDraftSuspects } from "../ticketing/build-ticket-draft.js";
import { readCodeOwnersForFile } from "../ticketing/read-code-owners.js";
import type { CodeOwners, TicketDraft } from "../ticketing/ticket-types.js";

const NO_CODE_OWNERS: CodeOwners = { emails: [], handles: [] };

export async function prepareTicketDrafts(store: Store, configuration: LoadedConfiguration, report: Report): Promise<TicketDraft[]> {
  const drafts: TicketDraft[] = [];
  for (const serviceReport of report.services) {
    const serviceSettings = configuration.services[serviceReport.serviceName];
    if (serviceReport.isSkipped || serviceSettings === undefined || serviceReport.regressions.length === 0) continue;
    const clusters = await store.listClusters(serviceReport.serviceName);

    // The deploys with regressions, in report order.
    const deployShas = [...new Set(serviceReport.regressions.map((regression) => regression.deploySha))];
    for (const deploySha of deployShas) {
      const regressions = serviceReport.regressions.filter((regression) => regression.deploySha === deploySha);
      const topSuspect = rankDraftSuspects(regressions)[0];
      const codeOwners =
        topSuspect === undefined || topSuspect.filePath === ""
          ? NO_CODE_OWNERS
          : await readCodeOwnersForFile(serviceSettings.repo, deploySha, topSuspect.filePath);
      const draft = buildTicketDraft({
        serviceName: serviceReport.serviceName,
        deploySha,
        deployTime: regressions[0]!.deployTime,
        regressions,
        clusters,
        codeOwners,
      });
      if (draft !== undefined) drafts.push(draft);
    }
  }
  return drafts;
}
