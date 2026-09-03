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

// Every surface that spells the count out in words. A shape added
// without touching one of these is how the docs drifted to three
// different numbers at once.
const COUNTED = {
  "AGENTS.md": path.join(ROOT, "AGENTS.md"),
  "docs/reference/cli.md": path.join(ROOT, "docs/reference/cli.md"),
  "packages/cli/src/ask.ts": ASK,
  "packages/cli/src/run.ts": path.join(ROOT, "packages/cli/src/run.ts"),
  "packages/mcp/src/tools.ts": path.join(ROOT, "packages/mcp/src/tools.ts"),
  "packages/mcp/src/index.ts": path.join(ROOT, "packages/mcp/src/index.ts"),
};
const NUMBER_WORDS = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
];

const problems = [];

const expected = NUMBER_WORDS[shapes.size];
for (const [name, file] of Object.entries(COUNTED)) {
  const counts = [
    ...fs.readFileSync(file, "utf8").matchAll(/\b(\w+) questions\b/gi),
  ]
    .map((match) => match[1].toLowerCase())
    .filter((word) => NUMBER_WORDS.includes(word));
  for (const word of counts) {
    if (word !== expected) {
      problems.push(
        `${name} says "${word} questions" and ask.ts answers ${expected}.`,
      );
    }
  }
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
