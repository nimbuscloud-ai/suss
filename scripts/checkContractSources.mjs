#!/usr/bin/env node
// checkContractSources.mjs: every place that lists the `--from` sources
// spells the same list as the ContractSource union the CLI accepts.
// Terraform and wrangler were added without the hand-written lists catching up.

import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

function read(relative) {
  return fs.readFileSync(path.join(ROOT, relative), "utf8");
}

/** The members of the `ContractSource` string union. */
function declaredSources() {
  const source = read("packages/cli/src/contract.ts");
  const start = source.indexOf("export type ContractSource =");
  if (start < 0) {
    throw new Error("ContractSource is not a string union any more.");
  }
  const body = source.slice(start, source.indexOf(";", start));
  return [...body.matchAll(/"([a-z-]+)"/g)].map((m) => m[1]);
}

/** Each place that spells the list, and how to pull the names out of it. */
const LISTINGS = [
  {
    label: "docs/reference/cli/contract.md",
    file: "docs/reference/cli/contract.md",
    names: (text) =>
      [...text.matchAll(/^\| `([a-z][a-z-]*)` \| /gm)].map((m) => m[1]),
  },
  {
    label: "docs/packs/contract-sources.md",
    file: "docs/packs/contract-sources.md",
    names: (text) => [...text.matchAll(/^## `([a-z-]+)`/gm)].map((m) => m[1]),
  },
  {
    label: "README.md",
    file: "README.md",
    names: (text) => {
      const line = text
        .split("\n")
        .find((l) => l.includes("reached with `--from`"));
      if (!line) {
        return [];
      }
      return [...line.matchAll(/`([a-z-]+)`/g)].map((m) => m[1]).slice(1);
    },
  },
  {
    label: "SUPPORTED_FROM in packages/cli/src/run.ts",
    file: "packages/cli/src/run.ts",
    names: (text) => {
      const start = text.indexOf("const SUPPORTED_FROM");
      const body = text.slice(start, text.indexOf("];", start));
      return [...body.matchAll(/"([a-z-]+)"/g)].map((m) => m[1]);
    },
  },
  {
    label: "the --from help text in packages/cli/src/run.ts",
    file: "packages/cli/src/run.ts",
    names: (text) => {
      const start = text.indexOf("What kind of file to read:");
      const body = text.slice(start, text.indexOf(".", start));
      return [...body.matchAll(/\b([a-z]+(?:-[a-z]+)*)\b/g)]
        .map((m) => m[1])
        .filter(
          (name) =>
            !["what", "kind", "of", "file", "to", "read"].includes(name),
        );
    },
  },
];

const declared = declaredSources();
let failed = false;

for (const listing of LISTINGS) {
  const listed = listing.names(read(listing.file));
  for (const name of declared.filter((n) => !listed.includes(n))) {
    console.error(`${listing.label} does not list --from ${name}.`);
    failed = true;
  }
  for (const name of listed.filter((n) => !declared.includes(n))) {
    console.error(
      `${listing.label} lists --from ${name}, which contract.ts does not accept.`,
    );
    failed = true;
  }
}

if (failed) {
  console.error(
    "\nContractSource in packages/cli/src/contract.ts is the list; every place above spells it in full.",
  );
  process.exit(1);
}

console.log(
  `Every one of the ${declared.length} contract sources is listed in all ${LISTINGS.length} places.`,
);
