// One line of `vika doctor` output: what was checked, how it went, and
// (for WARN and FAIL) what to do about it, in plain English.
export type CheckLevel = "OK" | "WARN" | "FAIL";

export interface DoctorCheck {
  area: string; // "configuration", "database", "service shopfront: logs", "tracker", ...
  level: CheckLevel;
  message: string;
  fix: string | null;
}

export const passCheck = (area: string, message: string): DoctorCheck => ({ area, level: "OK", message, fix: null });
export const warnCheck = (area: string, message: string, fix: string): DoctorCheck => ({ area, level: "WARN", message, fix });
export const failCheck = (area: string, message: string, fix: string): DoctorCheck => ({ area, level: "FAIL", message, fix });
