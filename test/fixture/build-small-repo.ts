// Builds tiny git repos for tests that need a specific history (a lockfile
// bump, a bot author, an author who isn't the committer...).
//
// Like build.ts, every repo lives in a new temp folder OUTSIDE this project,
// and git runs with the user's own config ignored, so commits can only ever
// land in that temp repo. The caller deletes `root` when done.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { git } from "./build.js";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export interface Person {
  name: string;
  email: string;
}

export interface CommitOptions {
  message: string;
  author: Person;
  committer?: Person; // defaults to the author
  time: string; // ISO; used for both author and committer time
}

export interface SmallRepo {
  root: string; // delete this when done
  repoPath: string;
  // Writes the files (null deletes one), commits everything, returns the sha.
  commit(files: Record<string, string | null>, options: CommitOptions): string;
}

export function buildSmallRepo(): SmallRepo {
  const root = mkdtempSync(join(tmpdir(), "vika-small-repo-"));
  const pathFromProject = relative(realpathSync(PROJECT_ROOT), realpathSync(root));
  if (pathFromProject === "" || (!pathFromProject.startsWith("..") && !isAbsolute(pathFromProject))) {
    throw new Error(`refusing to build a test repo inside the project: ${root}`);
  }

  const repoPath = join(root, "repo");
  mkdirSync(repoPath);
  git(repoPath, ["init", "-q", "-b", "main"]);
  // Safety check: git must see the temp repo as its own top level, not this project.
  if (realpathSync(git(repoPath, ["rev-parse", "--show-toplevel"])) !== realpathSync(repoPath)) {
    throw new Error("test repo is not isolated; refusing to commit");
  }

  return {
    root,
    repoPath,
    commit(files, options) {
      for (const [filePath, content] of Object.entries(files)) {
        const fullPath = join(repoPath, filePath);
        if (content === null) {
          rmSync(fullPath);
        } else {
          mkdirSync(dirname(fullPath), { recursive: true });
          writeFileSync(fullPath, content);
        }
      }
      const committer = options.committer ?? options.author;
      const gitDate = `${Math.floor(Date.parse(options.time) / 1000)} +0000`;
      git(repoPath, ["add", "-A"]);
      git(repoPath, ["-c", "commit.gpgsign=false", "commit", "-q", "--no-verify", "-m", options.message], {
        GIT_AUTHOR_NAME: options.author.name,
        GIT_AUTHOR_EMAIL: options.author.email,
        GIT_AUTHOR_DATE: gitDate,
        GIT_COMMITTER_NAME: committer.name,
        GIT_COMMITTER_EMAIL: committer.email,
        GIT_COMMITTER_DATE: gitDate,
      });
      return git(repoPath, ["rev-parse", "HEAD"]);
    },
  };
}
