


export const LANGUAGES = ["javascript", "python"] as const;

export type Language = (typeof LANGUAGES)[number];


export const DEFAULT_LANGUAGE: Language = "javascript";
