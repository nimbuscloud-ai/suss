// init.ts — work out which packs a project needs, and say so.
//
// Picking packs by hand means reading the pack list, matching it against
// your dependencies, and knowing that a SAM template implies two of them
// while a Prisma schema implies a third. That is a research task before
// anyone has seen a single summary.
//
// Everything needed to answer it is already on disk. Dependencies name
// the frameworks and clients. Files on disk name the contract sources.
// So read both and print the commands.
//
// Nothing is written or installed. The output is a list of commands to
// run, which stays useful whether the reader wants to paste them, put
// them in CI, or read them and do something else.

import fs from "node:fs";
import path from "node:path";

import { bold, cyan, dim, green, yellow } from "./style.js";

/** A pack, and the evidence that suggested it. */
export interface PackSuggestion {
  /** The `-f` name, or the `--from` name for a contract source. */
  name: string;
  /** The npm package to install. */
  packageName: string;
  /** What in the project pointed at it. */
  because: string;
  kind: "framework" | "client" | "contract";
  /** For a contract source, the file to read. */
  file?: string;
}

export interface InitReport {
  root: string;
  /** Null when the project has no tsconfig, which is fine. */
  tsconfig: string | null;
  suggestions: PackSuggestion[];
}

/**
 * A dependency in package.json, and the pack that reads code using it.
 * Prefix matched, so `@aws-sdk/client-sqs` matches its own entry rather
 * than every AWS SDK package.
 */
const BY_DEPENDENCY: Array<{
  dependency: string;
  name: string;
  packageName: string;
  kind: PackSuggestion["kind"];
}> = [
  {
    dependency: "hono",
    name: "hono",
    packageName: "@suss/framework-hono",
    kind: "framework",
  },
  {
    dependency: "next",
    name: "nextjs",
    packageName: "@suss/framework-nextjs",
    kind: "framework",
  },
  {
    dependency: "express",
    name: "express",
    packageName: "@suss/framework-express",
    kind: "framework",
  },
  {
    dependency: "fastify",
    name: "fastify",
    packageName: "@suss/framework-fastify",
    kind: "framework",
  },
  {
    dependency: "@ts-rest/core",
    name: "ts-rest",
    packageName: "@suss/framework-ts-rest",
    kind: "framework",
  },
  {
    dependency: "@nestjs/common",
    name: "nestjs-rest",
    packageName: "@suss/framework-nestjs-rest",
    kind: "framework",
  },
  {
    dependency: "@nestjs/graphql",
    name: "nestjs-graphql",
    packageName: "@suss/framework-nestjs-graphql",
    kind: "framework",
  },
  {
    dependency: "@apollo/server",
    name: "apollo",
    packageName: "@suss/framework-apollo",
    kind: "framework",
  },
  {
    dependency: "react-router",
    name: "react-router",
    packageName: "@suss/framework-react-router",
    kind: "framework",
  },
  {
    dependency: "react-router-dom",
    name: "react-router",
    packageName: "@suss/framework-react-router",
    kind: "framework",
  },
  {
    dependency: "react",
    name: "react",
    packageName: "@suss/framework-react",
    kind: "framework",
  },
  {
    dependency: "@types/aws-lambda",
    name: "aws-lambda",
    packageName: "@suss/framework-aws-lambda",
    kind: "framework",
  },
  {
    dependency: "@prisma/client",
    name: "prisma",
    packageName: "@suss/framework-prisma",
    kind: "framework",
  },
  {
    dependency: "drizzle-orm",
    name: "drizzle",
    packageName: "@suss/framework-drizzle",
    kind: "framework",
  },
  {
    dependency: "@aws-sdk/client-sqs",
    name: "aws-sqs",
    packageName: "@suss/framework-aws-sqs",
    kind: "framework",
  },
  {
    dependency: "@aws-sdk/client-eventbridge",
    name: "aws-eventbridge",
    packageName: "@suss/framework-aws-eventbridge",
    kind: "framework",
  },
  {
    dependency: "@apollo/client",
    name: "apollo-client",
    packageName: "@suss/client-apollo",
    kind: "client",
  },
  {
    dependency: "axios",
    name: "axios",
    packageName: "@suss/client-axios",
    kind: "client",
  },
];

/**
 * A file on disk, and the contract reader that understands it. The
 * matcher takes a filename so a glob-ish check stays in one place.
 */
const BY_FILE: Array<{
  matches: (filename: string) => boolean;
  name: string;
  packageName: string;
  describe: (relativePath: string) => string;
}> = [
  {
    matches: (f) => f === "template.yaml" || f === "template.yml",
    name: "cloudformation",
    packageName: "@suss/contract-cloudformation",
    describe: (p) => `a SAM template at ${p}`,
  },
  {
    matches: (f) => f === "schema.prisma",
    name: "prisma",
    packageName: "@suss/contract-prisma",
    describe: (p) => `a Prisma schema at ${p}`,
  },
  {
    matches: (f) => f.endsWith(".graphql") && !f.includes(".test."),
    name: "graphql",
    packageName: "@suss/contract-graphql",
    describe: (p) => `a GraphQL schema at ${p}`,
  },
  {
    matches: (f) => /^openapi\.(ya?ml|json)$/.test(f),
    name: "openapi",
    packageName: "@suss/contract-openapi",
    describe: (p) => `an OpenAPI document at ${p}`,
  },
  {
    matches: (f) => f.endsWith(".stories.tsx") || f.endsWith(".stories.ts"),
    name: "storybook",
    packageName: "@suss/contract-storybook",
    describe: (p) => `Storybook stories, the first at ${p}`,
  },
];

const SKIP_DIRECTORIES = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  ".git",
  ".turbo",
  ".next",
  ".suss",
  "vendor",
]);

/** Read the project and work out which packs apply. */
export function inspectProject(root: string): InitReport {
  const resolved = path.resolve(root);
  const suggestions: PackSuggestion[] = [];
  const seen = new Set<string>();

  const add = (suggestion: PackSuggestion): void => {
    const key = `${suggestion.kind}:${suggestion.name}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    suggestions.push(suggestion);
  };

  for (const [dependency, entry] of dependenciesOf(resolved)) {
    const match = BY_DEPENDENCY.find((d) => d.dependency === dependency);
    if (match !== undefined) {
      add({
        name: match.name,
        packageName: match.packageName,
        because: `${dependency} in ${entry}`,
        kind: match.kind,
      });
    }
  }

  for (const file of filesUnder(resolved)) {
    const relative = path.relative(resolved, file);
    const filename = path.basename(file);
    for (const rule of BY_FILE) {
      if (rule.matches(filename)) {
        add({
          name: rule.name,
          packageName: rule.packageName,
          because: rule.describe(relative),
          kind: "contract",
          file: relative,
        });
      }
    }
  }

  const tsconfig = ["tsconfig.json", "jsconfig.json"]
    .map((name) => path.join(resolved, name))
    .find((candidate) => fs.existsSync(candidate));

  return { root: resolved, tsconfig: tsconfig ?? null, suggestions };
}

/** Every dependency name in package.json, with which field it came from. */
function dependenciesOf(root: string): Array<[string, string]> {
  const manifest = path.join(root, "package.json");
  if (!fs.existsSync(manifest)) {
    return [];
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(fs.readFileSync(manifest, "utf8"));
  } catch {
    return [];
  }

  const found: Array<[string, string]> = [];
  for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
    const deps = parsed[field];
    if (deps === null || typeof deps !== "object") {
      continue;
    }
    for (const name of Object.keys(deps as Record<string, string>)) {
      found.push([name, field]);
    }
  }
  return found;
}

function* filesUnder(dir: string, depth = 0): Generator<string> {
  // A SAM template or a schema sits near the top of a service, so going
  // deeper finds mostly source files, which the dependency scan already
  // covers. Pointed at a home directory, a deeper walk also starts
  // reporting other people's projects as if they were this one.
  if (depth > 3) {
    return;
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || SKIP_DIRECTORIES.has(entry.name)) {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // A directory with its own package.json is its own project. Its
      // schemas belong to it, so stop rather than claim them here.
      if (depth > 0 && fs.existsSync(path.join(full, "package.json"))) {
        continue;
      }
      yield* filesUnder(full, depth + 1);
    } else {
      yield full;
    }
  }
}

/**
 * What was found, what to install, and what to run.
 *
 * Written to be read top to bottom and stopped at any point: the
 * evidence first, so a wrong guess is visible, then the commands.
 */
export function formatInitReport(report: InitReport): string {
  const lines: string[] = [];
  const { suggestions } = report;

  if (suggestions.length === 0) {
    lines.push(`${yellow("!")} Nothing in ${report.root} matched a pack.`);
    lines.push("");
    lines.push(
      dim(
        "  suss reads code through a pack per framework, client, or schema it",
      ),
    );
    lines.push(
      dim("  recognizes, and this project's dependencies name none of them."),
    );
    lines.push(dim("  Run `suss --help` for the built-in list."));
    return `${lines.join("\n")}\n`;
  }

  const frameworks = suggestions.filter((s) => s.kind === "framework");
  const clients = suggestions.filter((s) => s.kind === "client");
  const contracts = suggestions.filter((s) => s.kind === "contract");

  lines.push(
    `${green("✓")} Found ${bold(describeCount(suggestions.length, "thing"))} to read in ${report.root}`,
  );
  lines.push("");
  for (const group of [
    { label: "Your code", items: [...frameworks, ...clients] },
    { label: "Declared contracts", items: contracts },
  ]) {
    if (group.items.length === 0) {
      continue;
    }
    lines.push(`  ${bold(group.label)}`);
    for (const item of group.items) {
      lines.push(`    ${cyan(item.name.padEnd(16))} ${dim(item.because)}`);
    }
    lines.push("");
  }

  lines.push(bold("1. Install the packs"));
  lines.push("");
  lines.push(
    `   npm install --save-dev @suss/cli ${suggestions.map((s) => s.packageName).join(" ")}`,
  );
  lines.push("");

  lines.push(bold("2. Read each side into one folder"));
  lines.push("");
  const code = [...frameworks, ...clients];
  if (code.length > 0) {
    // One pass over the project reads every pack, so one command does.
    const flags = code.map((item) => `-f ${item.name}`).join(" ");
    lines.push(`   suss extract ${flags} -o summaries/code.json`);
  }
  for (const item of contracts) {
    lines.push(
      `   suss contract --from ${item.name} ${item.file ?? "<path>"} -o summaries/${item.name}.json`,
    );
  }
  lines.push("");

  lines.push(bold("3. Compare them"));
  lines.push("");
  lines.push("   suss check --dir summaries/");
  lines.push("");

  lines.push(bold("4. Decide what to do about the findings"));
  lines.push("");
  lines.push(
    dim(
      "   Anything you have reviewed and accepted goes in .sussignore at the",
    ),
  );
  lines.push(
    dim(
      "   repo root, with a reason, so the next person knows it was a choice:",
    ),
  );
  lines.push("");
  lines.push(dim('   { "rules": [{ "kind": "unhandledProviderCase",'));
  lines.push(
    dim('                "boundary": "GET /legacy/*", "effect": "hide",'),
  );
  lines.push(
    dim('                "reason": "legacy route, retiring in Q3" }] }'),
  );
  lines.push("");

  lines.push(bold("5. Run it on every change"));
  lines.push("");
  lines.push(
    dim(
      "   `check` exits non-zero on an error, so the two commands above work",
    ),
  );
  lines.push(
    dim("   as a CI step unchanged. Add --fail-on warning to gate harder."),
  );

  if (report.tsconfig === null) {
    lines.push("");
    lines.push(
      dim(
        "   No tsconfig here, so suss reads the directory. Pass -p to point it",
      ),
    );
    lines.push(dim("   at a particular one instead."));
  }

  return `${lines.join("\n")}\n`;
}

function describeCount(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}
