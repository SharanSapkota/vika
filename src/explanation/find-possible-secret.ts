


const POSSIBLE_SECRET_PATTERNS: { description: string; pattern: RegExp }[] = [
  { description: "an sk- API key", pattern: /\bsk-[A-Za-z0-9_-]{16,}/ },
  { description: "an AWS access key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { description: "a private key block", pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/ },
  { description: "a GitHub token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/ },
  {
    description: "a long value next to a word like secret or password",
    pattern: /(?:secret|password|passwd|token|api[_-]?key|access[_-]?key|credential)\w*["']?\s*[:=]\s*["']?[A-Za-z0-9_\-+/=.]{16,}/i,
  },
];


export function findPossibleSecret(text: string): string | null {
  const match = POSSIBLE_SECRET_PATTERNS.find((candidate) => candidate.pattern.test(text));
  return match === undefined ? null : match.description;
}
