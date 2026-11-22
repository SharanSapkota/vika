// Pieces shared by the JavaScript and Python fixture apps: the deploy shape,
// the people who commit, the fixed log timeline, seeded random numbers and
// fake values, and the helper that finds a frame's line in a file.

export interface Deploy {
  sha: string;
  time: string; // ISO timestamp
  previousSha: string | null; // null for the very first deploy
}

export const BACKGROUND_ERROR = "DB timeout after 5000ms";

export const LOG_START = Date.parse("2026-03-01T00:00:00.000Z");
export const LOG_END = Date.parse("2026-03-11T00:00:00.000Z");

export const FIRST_ERROR_DELAY_MS = (4 * 60 + 7) * 1000 + 312;

export interface Author {
  name: string;
  email: string;
}

export const PRIYA: Author = { name: "Priya Raman", email: "priya@example.com" };
export const TOMAS: Author = { name: "Tomas Ortega", email: "tomas@example.com" };
export const MEI: Author = { name: "Mei Chen", email: "mei@example.com" };

// One commit of a fixture app. `change` updates the app's state; the files
// are then rendered from that state.
export interface CommitPlan<State> {
  author: Author;
  time: string;
  message: string;
  pr: number;
  change: (s: State) => void;
  deployAfter?: string; // deploy time, if a deploy happens right after this commit
  bad?: boolean; // the seeded bug
}

export function lines(...parts: string[]): string {
  return parts.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Seeded random numbers and fake values
// ---------------------------------------------------------------------------

// mulberry32: small, fast, seeded PRNG. Same seed -> same sequence.
export function makeRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Fake {
  constructor(private readonly rand: () => number) {}

  int(min: number, max: number): number {
    return min + Math.floor(this.rand() * (max - min + 1));
  }

  pick<T>(items: readonly T[]): T {
    return items[this.int(0, items.length - 1)] as T;
  }

  hex(length: number): string {
    let out = "";
    for (let i = 0; i < length; i++) out += this.int(0, 15).toString(16);
    return out;
  }

  uuid(): string {
    const variant = this.pick(["8", "9", "a", "b"]);
    return `${this.hex(8)}-${this.hex(4)}-4${this.hex(3)}-${variant}${this.hex(3)}-${this.hex(12)}`;
  }

  userId(): string {
    return `u_${this.int(10000, 99999)}`;
  }

  orderId(): string {
    return `ord_${this.hex(8)}`;
  }

  ip(): string {
    return this.pick([
      () => `10.${this.int(0, 255)}.${this.int(0, 255)}.${this.int(1, 254)}`,
      () => `203.0.113.${this.int(1, 254)}`,
      () => `198.51.100.${this.int(1, 254)}`,
    ])();
  }

  email(): string {
    const first = this.pick(["alex", "sam", "jordan", "taylor", "casey", "morgan", "riley", "jamie"]);
    return `${first}.${this.int(1, 999)}@${this.pick(["example.com", "example.org", "example.net"])}`;
  }
}

export interface LogEvent {
  at: number; // epoch ms
  text: string; // may span several lines (stack trace)
}

// One stack frame that points at a real line of the fake repo.
export interface FrameSpec {
  fn: string;
  file: string; // repo-relative path
  lineText: string; // unique text on the target line
  colText: string; // text the column should point at
}

// Finds the line and column of a frame in a file's content at the deployed sha.
export function locate(content: string, spec: FrameSpec): { line: number; col: number } {
  const fileLines = content.split("\n");
  const index = fileLines.findIndex((l) => l.includes(spec.lineText));
  if (index === -1 || fileLines.findLastIndex((l) => l.includes(spec.lineText)) !== index) {
    throw new Error(`fixture bug: "${spec.lineText}" must appear exactly once in ${spec.file}`);
  }
  const col = (fileLines[index] as string).indexOf(spec.colText);
  if (col === -1) throw new Error(`fixture bug: "${spec.colText}" not on line ${index + 1} of ${spec.file}`);
  return { line: index + 1, col: col + 1 };
}

// Everything that differs between the fixture apps. The builder in build.ts
// makes the commits, records the deploys and writes the files from this.
export interface FixtureApp<State> {
  language: "javascript" | "python";
  initialState: State;
  commitPlans: CommitPlan<State>[];
  renderApp(state: State): Record<string, string>;
  randomSeed: number;
  // The log text, with stack traces read from the repo at the bad deploy.
  buildLog(fake: Fake, deploys: Deploy[], badDeploy: Deploy, readFileAtSha: (sha: string, path: string) => string): { text: string; firstSeen: string };
}
