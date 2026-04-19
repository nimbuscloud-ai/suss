// Dogfood script — run suss's adapter against suss's own source
// and see what falls out.
//
// The point isn't to produce a shipping artifact; it's to sit in
// the user's chair for a minute: "here's a TypeScript codebase, I
// want summaries from it, what happens?" The observations go into
// docs/dogfooding.md.
//
// This intentionally uses the programmatic adapter (rather than the
// CLI) because (a) half the value is seeing what the in-process API
// feels like and (b) it lets us compare results across packs inline
// without shelling out.

import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createTypeScriptAdapter } from "../packages/adapter/typescript/dist/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

// Three experiments, each pointed at a different slice of suss.
// We run them serially and print a summary of each.
const experiments = [
  {
    name: "checker (pure-ts utility module surface)",
    tsconfig: path.join(repoRoot, "packages/checker/tsconfig.json"),
  },
  {
    name: "cli (CLI dispatch + command runners)",
    tsconfig: path.join(repoRoot, "packages/cli/tsconfig.json"),
  },
  {
    name: "framework-apollo (pack + declarative discovery config)",
    tsconfig: path.join(repoRoot, "packages/framework/apollo/tsconfig.json"),
  },
];

// A dogfood-only pack: discover every named export as a code unit.
// `namedExport` with a wildcard `["*"]`? No — the discovery matcher
// only takes concrete names. So we give it the names we think matter
// in a utility module: whatever the adapter already recognises as
// exported functions. Falling back to a handful of common names
// surfaces roughly the right slice.
//
// This is the first real dogfood finding: we don't have a
// "discover every exported function" primitive. The pack shape
// assumes you know what entry-point names your framework declares.
// See docs/dogfooding.md for the writeup.
const dogfoodPack = {
  name: "suss-internal",
  languages: ["typescript"],
  protocol: "in-process",
  discovery: [
    {
      kind: "handler",
      // Invent a handful of "likely function names" — `check*`,
      // `pair*`, `extract*`, `discover*`. A discovery plugin that
      // takes a regex or `"*"` would make this unnecessary.
      match: {
        type: "namedExport",
        names: [
          "checkAll",
          "checkPair",
          "pairSummaries",
          "pairGraphqlOperations",
          "extractFromSourceFile",
          "discoverUnits",
          "assembleSummary",
          "apolloFramework",
        ],
      },
    },
  ],
  terminals: [
    { kind: "return", match: { type: "returnStatement" }, extraction: {} },
    { kind: "throw", match: { type: "throwExpression" }, extraction: {} },
  ],
  inputMapping: {
    type: "positionalParams",
    params: [
      { position: 0, role: "arg0" },
      { position: 1, role: "arg1" },
      { position: 2, role: "arg2" },
    ],
  },
};

const report = { experiments: [] };

for (const exp of experiments) {
  console.log(`\n=== ${exp.name} ===`);
  console.log(`tsconfig: ${path.relative(repoRoot, exp.tsconfig)}`);

  const adapter = createTypeScriptAdapter({
    tsConfigFilePath: exp.tsconfig,
    frameworks: [dogfoodPack],
  });

  const summaries = adapter.extractAll();

  console.log(`  summaries: ${summaries.length}`);
  for (const s of summaries) {
    console.log(
      `    - ${s.kind} ${s.identity.name}  (${s.transitions.length} transitions, ${s.inputs.length} inputs, confidence ${s.confidence.level})`,
    );
  }

  const opaqueCount = summaries
    .flatMap((s) => s.transitions)
    .flatMap((t) => t.conditions)
    .filter((c) => c.type === "opaque").length;
  const totalConditions = summaries
    .flatMap((s) => s.transitions)
    .flatMap((t) => t.conditions).length;
  console.log(
    `  opaque predicates: ${opaqueCount}/${totalConditions} (${totalConditions === 0 ? "—" : `${Math.round((opaqueCount / totalConditions) * 100)}%`})`,
  );

  report.experiments.push({
    name: exp.name,
    tsconfig: path.relative(repoRoot, exp.tsconfig),
    summaryCount: summaries.length,
    opaqueRatio: totalConditions === 0 ? null : opaqueCount / totalConditions,
    summaries: summaries.map((s) => ({
      name: s.identity.name,
      kind: s.kind,
      file: s.location.file,
      transitionCount: s.transitions.length,
      inputCount: s.inputs.length,
      confidence: s.confidence.level,
      opaquePredicates: s.transitions
        .flatMap((t) => t.conditions)
        .filter((c) => c.type === "opaque").length,
    })),
  });
}

const outPath = path.join(repoRoot, "scripts", "dogfood-report.json");
writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log(`\nFull report written to ${path.relative(repoRoot, outPath)}`);
