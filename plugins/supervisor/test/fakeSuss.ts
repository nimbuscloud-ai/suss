/**
 * A stand-in for suss, installed in a test project's node_modules so the
 * hooks pick it up the way they pick up a project's own suss. It reads
 * what to do from `.fake-suss.json` in the project, which a test
 * rewrites between hooks.
 */

import fs from "node:fs";
import path from "node:path";

import type { SinceReport } from "../scripts/types.js";

export interface FakeScript {
  /** How long each extract takes. */
  extractMs?: number;
  /** Extract writes nothing and says no pack matched. */
  extractFails?: boolean;
  /** What `check --since --json` prints. */
  check?: SinceReport;
}

const BIN = `import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const script = JSON.parse(fs.readFileSync(path.join(process.cwd(), ".fake-suss.json"), "utf8"));
const empty = { since: "", findings: [], resolved: [], changedBoundaries: [], run: [] };

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

export function scriptFakeSuss(project: string, script: FakeScript): void {
  fs.writeFileSync(
    path.join(project, ".fake-suss.json"),
    JSON.stringify(script),
  );
}
