// The kinds of sensitive data vika can redact, as named in vika.yaml's
// `redact` setting. Bearer tokens count as "jwt" (both are login tokens).
export const REDACTION_KINDS = ["email", "jwt", "ip", "cardlike"] as const;

export type RedactionKind = (typeof REDACTION_KINDS)[number];

export const ALL_REDACTION_KINDS: readonly RedactionKind[] = REDACTION_KINDS;
