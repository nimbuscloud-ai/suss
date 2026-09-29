import fs from "node:fs";

export type Stack = "typescript" | "python" | "ruby";

export interface RepoEntry {
  name: string;
  url: string;
  commit: string;
  stack: Stack;
  /** Where the server and the client that calls it live, for whoever grades the run. */
  sides: string;
}

const STACKS = new Set<string>(["typescript", "python", "ruby"]);
const FULL_SHA = /^[0-9a-f]{40}$/;

export function readRepoList(file: string): RepoEntry[] {
  const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(parsed)) {
    throw new Error(`${file}: expected an array of repositories`);
  }

  return parsed.map((raw, index) => checkEntry(raw, `${file}[${index}]`));
}

function checkEntry(raw: unknown, where: string): RepoEntry {
  const entry = raw as Partial<RepoEntry>;
  const fields = ["name", "url", "commit", "stack", "sides"] as const;
  for (const field of fields) {
    if (typeof entry[field] !== "string") {
      throw new Error(`${where}: ${field} must be a string`);
    }
  }

  if (!STACKS.has(entry.stack as string)) {
    throw new Error(`${where}: stack must be typescript, python or ruby`);
  }

  if (!FULL_SHA.test(entry.commit as string)) {
    throw new Error(`${where}: commit must be a full 40-character SHA`);
  }

  return entry as RepoEntry;
}
