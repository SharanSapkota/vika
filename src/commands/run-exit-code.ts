




import type { ServiceRunStatus } from "../pipeline/run-all-services.js";

export const EXIT_CODE_OK = 0;
export const EXIT_CODE_FAILURE = 1;
export const EXIT_CODE_BUSY = 2;

export function chooseRunExitCode(serviceStatuses: ServiceRunStatus[], hasTicketFailure: boolean): number {
  if (hasTicketFailure || serviceStatuses.some((serviceStatus) => serviceStatus.status === "failed")) return EXIT_CODE_FAILURE;
  if (serviceStatuses.some((serviceStatus) => serviceStatus.status === "busy")) return EXIT_CODE_BUSY;
  return EXIT_CODE_OK;
}
