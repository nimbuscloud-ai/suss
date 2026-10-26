#!/usr/bin/env node
/**
 * buildMapExamples.mjs: rebuild the `suss map` pages the docs site shows,
 * from public apps at the commits tools/first-run/repos.json pins.
 *
 *   npm run build && node scripts/buildMapExamples.mjs
 *
 * Each app is cloned at its pin into a temporary folder, set up with
 * `suss init --write`, and mapped with this checkout's build, with links
 * to GitHub at the pinned commit. The pages go to docs/public/examples,
 * which the site serves as they are. Run it with each release, so the
 * examples show what that release reads.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const CLI = path.join(ROOT, "packages", "cli", "dist", "bin.js");
const OUT = path.join(ROOT, "docs", "public", "examples");
/**
 * Each app, and the pack config init cannot settle on its own: which
 * database the ORM talks to. lobsters runs on MariaDB, through
 * ActiveRecord's mysql2 adapter, and the FastAPI template on PostgreSQL,
 * as each project's own setup says.
 */
const EXAMPLES = {
  lobsters: { "suss.activerecord.json": { storageSystem: "mysql" } },
  "full-stack-fastapi-template": {
    "backend/suss.sqlmodel.json": { storageSystem: "postgresql" },
  },
};
/** Past this a page is slow to open from the site, so the run says so. */
const LARGE_PAGE = 1024 * 1024;

if (!fs.existsSync(CLI)) {
  console.error(`No build at ${CLI}. Run \`npm run build\` first.`);
  process.exit(1);
}

const pins = JSON.parse(
  fs.readFileSync(path.join(ROOT, "tools", "first-run", "repos.json"), "utf8"),
);
const work = fs.mkdtempSync(path.join(os.tmpdir(), "suss-map-examples-"));
fs.mkdirSync(OUT, { recursive: true });

try {
  for (const [name, configs] of Object.entries(EXAMPLES)) {
    const pin = pins.find((entry) => entry.name === name);
    if (pin === undefined) {
      throw new Error(`tools/first-run/repos.json has no ${name}`);
    }
    const clone = path.join(work, name);
    run("git", ["init", "-q", clone]);
    run("git", ["-C", clone, "remote", "add", "origin", pin.url]);
    run("git", [
      "-C",
      clone,
      "fetch",
      "-q",
      "--depth",
      "1",
      "origin",
      pin.commit,
    ]);
    run("git", ["-C", clone, "checkout", "-q", "FETCH_HEAD"]);
    for (const [file, config] of Object.entries(configs)) {
      fs.writeFileSync(path.join(clone, file), `${JSON.stringify(config)}\n`);
    }
    run("node", [CLI, "init", "--write"], clone);

    const page = path.join(OUT, `${name}.html`);
    process.stdout.write(
      run("node", [CLI, "map", "--links", "github", "-o", page], clone),
    );
    // The same map as JSON, beside the page, for a reader who wants the data.
    // The second run reads from the extraction cache the first one wrote.
    const data = path.join(OUT, `${name}.json`);
    run("node", [CLI, "map", "--links", "github", "--json", "-o", data], clone);
    const size = fs.statSync(page).size;
    const note = size > LARGE_PAGE ? " (over 1 MB)" : "";
    console.log(
      `${name} at ${pin.commit.slice(0, 7)}: ${(size / 1024).toFixed(0)} KB${note}, JSON ${(fs.statSync(data).size / 1024).toFixed(0)} KB\n`,
    );
  }
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}

function run(command, args, cwd) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 64 * 1024 * 1024,
  });
}
