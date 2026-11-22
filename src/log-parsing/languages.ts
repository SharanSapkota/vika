// The programming languages vika can read stack traces and code for. Every
// rule that depends on the language lives in a lookup table keyed by these
// names, so adding a language means adding table entries, not if-chains.
export const LANGUAGES = ["javascript", "python"] as const;

export type Language = (typeof LANGUAGES)[number];

// Existing setups have no `language` setting and must behave as before.
export const DEFAULT_LANGUAGE: Language = "javascript";
