#!/usr/bin/env node
// checkAskShapes.mjs: every question shape ask.ts and askWhy.ts answer
// has a matching phrase in AGENTS.md and in docs/reference/cli.md, so a
// shape added to one and left out of the other fails the build.

import fs from "node:fs";
import path from "node:path";

import { ROOT } from "./workspacePackages.mjs";

const ASK = path.join(ROOT, "packages/cli/src/ask.ts");
const WHY = path.join(ROOT, "packages/cli/src/askWhy.ts");
const DOCS = {
  "AGENTS.md": path.join(ROOT, "AGENTS.md"),
  "docs/reference/cli.md": path.join(ROOT, "docs/reference/cli.md"),
};

const shapes = new Set(
  [ASK, WHY]
    .flatMap((file) => [
      ...fs.readFileSync(file, "utf8").matchAll(/shape:\s*"(\w+)"/g),
    ])
    .map((match) => match[1]),
);

// A phrase per shape, loose enough to survive a different placeholder
// name across the two docs, tight enough not to match another shape.
const PATTERN_BY_SHAPE = {
  declares: /what can i project from/i,
  reads: /what reads\b/i,
  writes: /what writes\b/i,
  invokes: /what invokes\b/i,
  calls: /what calls\b/i,
  reaches: /what does[^\n]*\breach\b/i,
  reachedBy: /what reaches\b/i,
  provides: /what does[^\n]*(provide|export)/i,
  whyReaches: /why does[^\n]*\breach\b/i,
  whyResolves: /why does[^\n]*resolve to/i,
};

const problems = [];

if (shapes.size !== 10) {
  problems.push(
    `ask.ts and askWhy.ts declare ${shapes.size} question shapes (${[...shapes].sort().join(", ")}), not the ten this check and the docs assume.`,
  );
}

for (const shape of shapes) {
  const pattern = PATTERN_BY_SHAPE[shape];
  if (pattern === undefined) {
    problems.push(
      `ask.ts answers a "${shape}" question and scripts/checkAskShapes.mjs has no phrase for it. Add one to PATTERN_BY_SHAPE.`,
    );
    continue;
  }
  for (const [name, file] of Object.entries(DOCS)) {
    if (!pattern.test(fs.readFileSync(file, "utf8"))) {
      problems.push(
        `${name} never mentions the "${shape}" question suss ask answers.`,
      );
    }
  }
}

if (problems.length > 0) {
  process.stderr.write(
    `${problems.length} ask-question doc problem(s):\n${problems
      .map((line) => `  ${line}\n`)
      .join("")}`,
  );
  process.exit(1);
}

process.stdout.write(
  `All ${shapes.size} suss ask question shapes are documented in AGENTS.md and docs/reference/cli.md.\n`,
);
