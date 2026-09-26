/**
 * A stand-in for suss, installed in a test project's node_modules so the
 * hooks pick it up the way they pick up a project's own suss. It reads
 * what to do from `.fake-suss.json` in the project, which a test
 * rewrites between hooks.
 */

import fs from "node:fs";
import path from "node:path";

import type { IntentCheck, SinceReport } from "../scripts/types.js";

export interface FakeScript {
  /** How long each extract takes. */
  extractMs?: number;
  /** Extract writes nothing and says no pack matched. */
  extractFails?: boolean;
  /** What `check --since --json` prints. */
  check?: SinceReport;
  /** What `intent check --json` prints. */
  intent?: IntentCheck;
  /** `intent check` refuses the change list with this sentence. */
  intentRefuses?: string;
  /** How long `intent check` takes. */
  intentMs?: number;
  /** `intent check` crashes, or is missing as in a release without it. */
  intentFails?: "crash" | "missing";
}

const BIN = `import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const script = JSON.parse(fs.readFileSync(path.join(process.cwd(), ".fake-suss.json"), "utf8"));
const empty = { since: "", findings: [], resolved: [], changedBoundaries: [], run: [] };
fs.appendFileSync(path.join(process.cwd(), ".fake-suss-calls.jsonl"), JSON.stringify(args) + "\\n");

const commands = {
  extract: async () => {
    await new Promise((resolve) => setTimeout(resolve, script.extractMs ?? 0));
    if (script.extractFails === true) {
      process.stderr.write("Nothing in this project matched a pack, so there is nothing to read.\\n");
      return 1;
    }
    const dir = args[args.indexOf("--out-dir") + 1];
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "0-extract.json"), "[]");
    return 0;
  },
  check: async () => {
    process.stdout.write(JSON.stringify(script.check ?? empty));
    return 0;
  },
  inspect: async () => {
    process.stdout.write(args.includes("--json") ? JSON.stringify({ version: 1, changed: 0, summaries: [] }) : "No behavioral changes.\\n");
    return 0;
  },
  intent: async () => {
    if (args[1] === "keep") {
      process.stdout.write("Kept 1 intent document.\\n");
      return 0;
    }
    await new Promise((resolve) => setTimeout(resolve, script.intentMs ?? 0));
    if (script.intentFails === "missing") {
      process.stderr.write('There is no "intent check". intent has outcomes.\\n');
      return 1;
    }
    if (script.intentFails === "crash") {
      process.stderr.write("TypeError: Cannot read properties of undefined (reading 'transitions')\\n    at checkIntent (intentCheck.js:1:1)\\n");
      return 1;
    }
    if (script.intentRefuses !== undefined) {
      const file = args[2];
      process.stdout.write(JSON.stringify({ version: 1, error: script.intentRefuses, rejected: { file, problems: [{ path: "changes.0", message: script.intentRefuses }] } }));
      process.stderr.write(script.intentRefuses + "\\n");
      return 1;
    }
    process.stdout.write(JSON.stringify(script.intent));
    return 0;
  },
};

process.exitCode = await commands[args[0]]();
`;

export function installFakeSuss(project: string, script: FakeScript): void {
  const pkg = path.join(project, "node_modules", "@suss", "cli");
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(
    path.join(pkg, "package.json"),
    JSON.stringify({
      name: "@suss/cli",
      version: "99.0.0",
      type: "module",
      bin: { suss: "bin.mjs" },
    }),
  );
  fs.writeFileSync(path.join(pkg, "bin.mjs"), BIN);
  scriptFakeSuss(project, script);
}

/** Every command line the stand-in ran, oldest first. */
export function fakeSussCalls(project: string): string[][] {
  const file = path.join(project, ".fake-suss-calls.jsonl");
  if (!fs.existsSync(file)) {
    return [];
  }
  return fs
    .readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[]);
}

export function scriptFakeSuss(project: string, script: FakeScript): void {
  fs.writeFileSync(
    path.join(project, ".fake-suss.json"),
    JSON.stringify(script),
  );
}
