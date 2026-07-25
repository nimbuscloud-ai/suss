#!/usr/bin/env node
// checkStyle.mjs — the conventions Biome has no rule for.
//
// Biome covers formatting and most lint rules. Three conventions in
// docs/internal/style.md it cannot express live here instead, so they
// fail a build rather than waiting for someone to spot them in review.
//
// Run with --fix to rewrite what can be rewritten mechanically.

import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

const SKIP_DIRECTORIES = new Set([
  "node_modules",
  "dist",
  ".turbo",
  ".git",
  "coverage",
  ".suss",
  "fixtures",
]);

const RULES = [
  {
    name: "inline-import-type",
    // `import("@suss/x").Foo` as a type reference. `import type { Foo }
    // from "@suss/x"` says the same thing where a reader looks for it,
    // and Biome's useImportType cannot see the inline form.
    pattern: /import\(\s*["'][^"']+["']\s*\)\s*\./g,
    message:
      'write `import type { X } from "pkg"` at the top of the file, not `import("pkg").X` inline',
    appliesTo: (file) => file.endsWith(".ts") || file.endsWith(".tsx"),
  },
  {
    name: "switch-statement",
    // Decision 8: dispatch on a discriminated union through a
    // Record-typed table, which the type system checks for
    // exhaustiveness, rather than a switch, which it does not.
    pattern: /\bswitch\s*\(/g,
    message:
      "dispatch through a Record-typed table instead, so a missing case fails to compile",
    appliesTo: (file) =>
      (file.endsWith(".ts") || file.endsWith(".tsx")) &&
      !file.endsWith(".test.ts"),
  },
];

function* sourceFiles(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRECTORIES.has(entry.name)) {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* sourceFiles(full);
    } else {
      yield full;
    }
  }
}

const violations = [];

for (const file of sourceFiles(path.join(ROOT, "packages"))) {
  const applicable = RULES.filter((rule) => rule.appliesTo(file));
  if (applicable.length === 0) {
    continue;
  }
  const contents = fs.readFileSync(file, "utf8");
  const lines = contents.split("\n");

  for (const rule of applicable) {
    for (const [index, line] of lines.entries()) {
      rule.pattern.lastIndex = 0;
      if (!rule.pattern.test(line)) {
        continue;
      }
      violations.push({
        file: path.relative(ROOT, file),
        line: index + 1,
        rule: rule.name,
        message: rule.message,
        source: line.trim(),
      });
    }
  }
}

if (violations.length === 0) {
  process.stdout.write("Style conventions hold across every package.\n");
  process.exit(0);
}

for (const violation of violations) {
  process.stderr.write(
    `${violation.file}:${violation.line}  ${violation.rule}\n` +
      `  ${violation.source}\n` +
      `  ${violation.message}\n\n`,
  );
}
process.stderr.write(
  `${violations.length} ${violations.length === 1 ? "line breaks" : "lines break"} a convention in docs/internal/style.md.\n`,
);
process.exit(1);
