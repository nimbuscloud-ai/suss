// longrunShape.mjs — exploratory session over the shape dimensions.
//
// Samples shapes, runs every oracle, groups what it finds by signature,
// minimizes one program per signature, and prints the per-dimension
// coverage of the sample. Usage:
//   node longrunShape.mjs [family] [count] [seed]
//     family: http | component | both   (default both)
// Build first (`npx tsup`) — imports from dist.
import fc from "fast-check";

import { reactFramework } from "@suss/framework-react";

import {
  ALL_SHAPE_TARGETS,
  arbComponentShapeSpec,
  arbShapeSpec,
  BINDING_FORMS,
  COMPONENT_FORMS,
  EXPORT_ROUTES,
  FUNCTION_FORMS,
  findingSignature,
  formatShapeFailure,
  minimizeComponentShape,
  minimizeShape,
  REACH_PATHS,
  RESULT_SHAPES,
  renderComponentShape,
  renderShape,
  repairComponentShape,
  repairShape,
  runComponentShapeDifferential,
  runShapeDifferential,
  SIMPLEST_COMPONENT_SHAPE,
  SIMPLEST_SHAPE,
  shapeFailed,
  WIDE_TYPE_SIZE,
} from "./dist/index.js";

const family = process.argv[2] ?? "both";
const count = Number.parseInt(process.argv[3] ?? "100", 10);
const seed = Number.parseInt(
  process.argv[4] ?? String(Date.now() % 2 ** 31),
  10,
);

const pack = reactFramework();
const target = ALL_SHAPE_TARGETS[0];

const PLAIN_HANDLER_BODY = {
  guards: [],
  final: {
    type: "respond",
    terminal: { status: 200, key: "ok", value: "yes" },
  },
};
const PLAIN_COMPONENT_BODY = {
  props: [],
  guards: [],
  root: { type: "element", tag: "div", children: [] },
};

const families = {
  http: {
    arb: arbShapeSpec,
    dimensions: ["form", "binding", "reach", "result"],
    values: {
      form: FUNCTION_FORMS,
      binding: BINDING_FORMS,
      reach: REACH_PATHS,
      result: RESULT_SHAPES,
    },
    baseline: { ...SIMPLEST_SHAPE, body: PLAIN_HANDLER_BODY },
    repair: repairShape,
    run: (spec) => runShapeDifferential(spec, target),
    minimize: (spec, signature) =>
      minimizeShape(spec, signature, (candidate) =>
        runShapeDifferential(candidate, target),
      ),
    files: (spec) =>
      renderShape({ spec, syntax: target.syntax, wideType: WIDE_TYPE_SIZE })
        .files,
  },
  component: {
    arb: arbComponentShapeSpec,
    dimensions: ["form", "binding", "route"],
    values: {
      form: COMPONENT_FORMS,
      binding: BINDING_FORMS,
      route: EXPORT_ROUTES,
    },
    baseline: { ...SIMPLEST_COMPONENT_SHAPE, body: PLAIN_COMPONENT_BODY },
    repair: repairComponentShape,
    run: (spec) => runComponentShapeDifferential(spec, pack),
    minimize: (spec, signature) =>
      minimizeComponentShape(spec, signature, (candidate) =>
        runComponentShapeDifferential(candidate, pack),
      ),
    files: (spec) => renderComponentShape(spec).files,
  },
};

const chosen = family === "both" ? ["http", "component"] : [family];

/**
 * One program per dimension value, with every other dimension at its
 * plainest, so a finding can be attributed to the one thing that
 * changed. The sample below says how often a shape fails; this says
 * which dimension is why.
 */
async function probe(runner) {
  console.log("\n--- one dimension at a time, everything else plainest ---");
  for (const [dimension, values] of Object.entries(runner.values)) {
    for (const value of values) {
      const spec = { ...runner.baseline, [dimension]: value };
      const result = await runner.run(runner.repair(spec));
      const signatures = [...new Set(result.findings.map(findingSignature))];
      console.log(
        `${`${dimension}=${value}`.padEnd(34)} ${
          signatures.length === 0
            ? "agrees with the baseline"
            : signatures.join(", ")
        }`,
      );
    }
  }
}

for (const name of chosen) {
  const runner = families[name];
  const specs = fc.sample(runner.arb, { numRuns: count, seed });

  const tally = new Map();
  for (const spec of specs) {
    for (const dimension of runner.dimensions) {
      const key = `${dimension}=${spec[dimension]}`;
      tally.set(key, (tally.get(key) ?? 0) + 1);
    }
  }

  await probe(runner);

  const started = performance.now();
  const bySignature = new Map();
  let clear = 0;
  for (const spec of specs) {
    const result = await runner.run(spec);
    if (!shapeFailed(result)) {
      clear++;
      continue;
    }
    for (const finding of result.findings) {
      const signature = findingSignature(finding);
      if (!bySignature.has(signature)) {
        bySignature.set(signature, { spec, count: 0, detail: finding.detail });
      }
      bySignature.get(signature).count++;
    }
  }
  const seconds = (performance.now() - started) / 1000;

  console.log(
    `\n=== ${name}: ${specs.length} programs in ${seconds.toFixed(1)}s ` +
      `(${(specs.length / (seconds / 60)).toFixed(0)}/min), ${clear} with nothing to report ===`,
  );

  console.log("\n--- per-dimension coverage ---");
  for (const [key, hits] of [...tally.entries()].sort()) {
    console.log(
      `${key.padEnd(34)} ${String(hits).padStart(4)}  ${((hits / specs.length) * 100).toFixed(1)}%`,
    );
  }

  console.log(`\n--- ${bySignature.size} distinct findings ---`);
  for (const [signature, { spec, count: hits }] of bySignature) {
    const minimal = await runner.minimize(spec, signature);
    const result = await runner.run(minimal);
    console.log(`\n##### ${signature} (${hits} programs)`);
    console.log(formatShapeFailure(result));
  }
}
