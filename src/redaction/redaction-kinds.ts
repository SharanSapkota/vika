export const REDACTION_KINDS = ["email", "jwt", "ip", "cardlike"] as const;

export type RedactionKind = (typeof REDACTION_KINDS)[number];

export const ALL_REDACTION_KINDS: readonly RedactionKind[] = REDACTION_KINDS;
