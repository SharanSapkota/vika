// `vika report --create-tickets`: after the report, turn each bad deploy into
// a ticket draft, ask a person to approve each one, and file the approved
// ones. Only this command ever talks to a tracker; `report` without the
// flag makes no tracker calls at all.
import { collectSecrets, runWithSecretsHidden } from "../configuration/hide-secrets.js";
import type { LoadedConfiguration } from "../configuration/load-configuration.js";
import { openStore } from "../database/database-store.js";
import type { StoreOptions } from "../database/store-types.js";
import { prepareTicketDrafts } from "../pipeline/prepare-ticket-drafts.js";
import type { Report } from "../reporting/report-types.js";
import { createTracker } from "../ticket-trackers/create-tracker.js";
import type { FetchFunction } from "../ticket-trackers/tracker-types.js";
import { createTicket } from "../ticketing/create-ticket.js";
import { approveAndCreateTickets, type ApprovalConsole, type ApprovalResult } from "./approve-and-create-tickets.js";

export interface CreateTicketsOptions {
  configuration: LoadedConfiguration;
  report: Report;
  fetchFunction: FetchFunction;
  approvalConsole: ApprovalConsole;
  storeOptions?: StoreOptions;
}

export async function runCreateTicketsCommand(options: CreateTicketsOptions): Promise<ApprovalResult[]> {
  const { configuration } = options;
  const secrets = collectSecrets(configuration);
  return runWithSecretsHidden(configuration, async () => {
    const tracker = createTracker(configuration, options.fetchFunction, secrets);
    if (tracker === null) {
      options.approvalConsole.write('\ntracker.type is "none" in vika.yaml, so no tickets can be filed.\n');
      return [];
    }
    const store = await openStore(configuration.databaseUrl, options.storeOptions);
    try {
      const drafts = await prepareTicketDrafts(store, configuration, options.report);
      return await approveAndCreateTickets(drafts, options.approvalConsole, (draft) => createTicket({ store, tracker, draft, secrets }));
    } finally {
      await store.close();
    }
  });
}
