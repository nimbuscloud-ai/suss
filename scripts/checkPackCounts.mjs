#!/usr/bin/env node
/**
 * checkPackCounts.mjs: the documented pack counts against the ones the
 * CLI ships.
 *
 * A count in prose goes stale the release after somebody writes it, and
 * nothing else notices. The README said thirty-eight packs and the
 * reference said twenty-two while the CLI shipped forty-three. Each
 * claim below names a file, the sentence it lives in, and what the
 * number has to be.
 *
 * Usage: `node scripts/checkPackCounts.mjs`
 */

import fs from "node:fs";
import path from "node:path";

import {
  contractSources,
  packDirectories,
  packNames,
  publishedPackages,
} from "./packInventory.mjs";
import { ROOT } from "./workspacePackages.mjs";

const ONES = [
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
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
];

const TENS = [
  "",
  "",
  "twenty",
  "thirty",
  "forty",
  "fifty",
  "sixty",
  "seventy",
  "eighty",
  "ninety",
];

/** `43` as `forty-three`, which is how the prose writes it. */
function inWords(n) {
  if (n < ONES.length) {
    return ONES[n];
  }
  const tens = TENS[Math.floor(n / 10)];
  const ones = n % 10;
  return ones === 0 ? tens : `${tens}-${ONES[ones]}`;
}

/** What a claim says, whether it was written as digits or as a word. */
function stated(text) {
  const digits = Number(text);
  if (!Number.isNaN(digits)) {
    return digits;
  }
  const word = text.toLowerCase();
  const said = ONES.indexOf(word);
  if (said !== -1) {
    return said;
  }
  const [tens, ones] = word.split("-");
  const found = TENS.indexOf(tens ?? "");
  return found === -1 ? null : found * 10 + (ones ? ONES.indexOf(ones) : 0);
}

const packs = packNames();
const frameworks = packDirectories("framework");
const clients = packDirectories("client");

const claims = [
  {
    file: "README.md",
    pattern: /^([\w-]+) packs read code today/im,
    expected: packs.length,
    about: "packs the CLI ships",
  },
  {
    file: "README.md",
    pattern: /^([\w-]+) contract readers turn a declared artifact/im,
    expected: contractSources().length,
    about: "contract sources `--from` takes",
  },
  {
    file: "docs/reference/packages.md",
    pattern: /^([\w-]+) packs read code today/im,
    expected: packs.length,
    about: "packs the CLI ships",
  },
  {
    file: "docs/reference/packages.md",
    pattern: /packs read code today, across ([\w-]+) frameworks/i,
    expected: frameworks.length,
    about: "packages under packages/framework",
  },
  {
    file: "docs/reference/packages.md",
    pattern: /([\w-]+) HTTP and GraphQL clients/i,
    expected: clients.length,
    about: "packages under packages/client",
  },
  {
    file: "docs/reference/packages.md",
    pattern: /([\w-]+) contract readers turn a declared artifact/i,
    expected: contractSources().length,
    about: "contract sources `--from` takes",
  },
  {
    file: "docs/internal/releasing.md",
    pattern: /All ([\w-]+) packages share one version/i,
    expected: publishedPackages().length,
    about: "packages a release publishes",
  },
  {
    file: "docs/internal/releasing.md",
    pattern: /- ([\w-]+) packages on the registry at the new version/i,
    expected: publishedPackages().length,
    about: "packages a release publishes",
  },
];

const problems = [];

for (const claim of claims) {
  const text = fs.readFileSync(path.join(ROOT, claim.file), "utf8");
  const found = text.match(claim.pattern);
  if (found === null) {
    problems.push(
      `${claim.file} no longer says how many ${claim.about}, so this check reads nothing. Either put the sentence back or take the claim out of scripts/checkPackCounts.mjs.`,
    );
    continue;
  }
  const said = stated(found[1]);
  if (said !== claim.expected) {
    problems.push(
      `${claim.file} says "${found[1]}" where there are ${claim.expected} ${claim.about}. Write "${inWords(claim.expected)}".`,
    );
  }
}

// checkPacks.mjs applies the same rule to the README.
const reference = "docs/reference/packages.md";
const text = fs.readFileSync(path.join(ROOT, reference), "utf8");
const missing = packs.filter(
  (name) => !new RegExp(`\`[^\`]*\\b${name}\\b[^\`]*\``).test(text),
);
if (missing.length > 0) {
  problems.push(
    `${reference} names no pack called ${missing.join(", ")}, and it is the page that says which pack a stack needs.`,
  );
}

if (problems.length > 0) {
  process.stdout.write(`✗ pack counts:\n  ${problems.join("\n  ")}\n`);
  process.exit(1);
}

process.stdout.write(
  `Every pack the CLI ships is documented, and the counts match: ${packs.length} packs, ${contractSources().length} contract readers.\n`,
);
