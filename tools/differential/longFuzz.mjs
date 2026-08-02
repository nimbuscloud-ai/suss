// longFuzz.mjs: the scheduled run.
//
// The per-pull-request run uses a fixed seed and takes a few seconds.
// This one seeds from the clock and generates far more, so it reaches
// shapes a fixed seed never draws.
//
// What it does with what it finds: it fails. Every bug the fuzzer knows
// about is written down in src/shape/knownBugs.ts, so a finding whose
// signature is not in that list is something nobody has seen, and a
// dimension value that stopped failing is a fix nobody pinned. Both
// exit non-zero with the minimized program, because a nightly that
// writes into a log and returns success is a nightly nobody reads.
//
// Usage: node longFuzz.mjs [programs] [seed]
import { spawnSync } from "node:child_process";

import fc from "fast-check";

import { nestjsRestFramework } from "@suss/framework-nestjs-rest";
import { reactFramework } from "@suss/framework-react";

import {
  ALL_SHAPE_TARGETS,
  ANNOUNCEMENT_BUGS,
  APOLLO_RESOLVER_BUGS,
  arbApolloResolverSpec,
  arbComponentShapeSpec,
  arbEnvShapeSpec,
  arbNestResolverSpec,
  arbPackageShapeSpec,
  arbQueueShapeSpec,
  arbShapeSpec,
  COMPONENT_BUGS,
  ENV_BUGS,
  findingSignature,
  formatShapeFailure,
  KNOWN_SIGNATURES,
  minimizeApolloResolverShape,
  minimizeComponentShape,
  minimizeEnvShape,
  minimizeNestResolverShape,
  minimizePackageShape,
  minimizeQueueShape,
  minimizeShape,
  NEST_RESOLVER_BUGS,
  PACKAGE_BUGS,
  QUEUE_BUGS,
  repairComponentShape,
  runAnnounceShapeDifferential,
  runApolloResolverDifferential,
  runComponentShapeDifferential,
  runEnvShapeDifferential,
  runNestResolverDifferential,
  runPackageShapeDifferential,
  runQueueShapeDifferential,
  runShapeDifferential,
  SIMPLEST_ANNOUNCEMENT,
  SIMPLEST_APOLLO_RESOLVER,
  SIMPLEST_ENV_SHAPE,
  SIMPLEST_NEST_RESOLVER,
  SIMPLEST_PACKAGE_SHAPE,
  SIMPLEST_QUEUE_SHAPE,
  shapeFailed,
} from "./dist/index.js";

const programs = Number.parseInt(
  process.argv[2] ?? process.env.FUZZ_PROGRAMS ?? "4000",
  10,
);
const seed = Number.parseInt(
  process.argv[3] ?? String(Date.now() % 2 ** 31),
  10,
);
const pack = reactFramework();
const nestPack = nestjsRestFramework();
const problems = [];

console.log(`seed ${seed}, ${programs} programs per family`);

// The property suites first, at the same random seed: they are the part
// that fails on a regression in a shape that works today.
const suite = spawnSync("npx", ["vitest", "run"], {
  stdio: "inherit",
  env: { ...process.env, SUSS_FUZZ_SEED: String(seed), SUSS_FUZZ_RUNS: "1500" },
});
if (suite.status !== 0) {
  problems.push("the property suites failed at this seed, see above");
}

const families = [
  {
    name: "http",
    arb: arbShapeSpec,
    run: (spec) => runShapeDifferential(spec, ALL_SHAPE_TARGETS[0]),
    minimize: (spec, signature) =>
      minimizeShape(spec, signature, (candidate) =>
        runShapeDifferential(candidate, ALL_SHAPE_TARGETS[0]),
      ),
  },
  {
    name: "component",
    arb: arbComponentShapeSpec,
    run: (spec) => runComponentShapeDifferential(spec, pack),
    minimize: (spec, signature) =>
      minimizeComponentShape(spec, signature, (candidate) =>
        runComponentShapeDifferential(candidate, pack),
      ),
  },
  {
    name: "apollo",
    arb: arbApolloResolverSpec,
    run: runApolloResolverDifferential,
    minimize: (spec, signature) =>
      minimizeApolloResolverShape(
        spec,
        signature,
        runApolloResolverDifferential,
      ),
  },
  {
    name: "nestjs-graphql",
    arb: arbNestResolverSpec,
    run: runNestResolverDifferential,
    minimize: (spec, signature) =>
      minimizeNestResolverShape(spec, signature, runNestResolverDifferential),
  },
  {
    name: "runtime-config",
    arb: arbEnvShapeSpec,
    run: runEnvShapeDifferential,
    minimize: (spec, signature) =>
      minimizeEnvShape(spec, signature, runEnvShapeDifferential),
  },
  {
    // Two packages and a manifest on disk per program, and thirty-five
    // combinations to cover.
    name: "package",
    arb: arbPackageShapeSpec,
    programs: Math.max(50, Math.round(programs / 8)),
    run: runPackageShapeDifferential,
    minimize: (spec, signature) =>
      minimizePackageShape(spec, signature, runPackageShapeDifferential),
  },
  {
    // Writes a template and reads it back, so a program here costs
    // several times what an in-memory one does. The space is also
    // smaller: two dimensions, thirty-six combinations.
    name: "queue",
    arb: arbQueueShapeSpec,
    programs: Math.max(50, Math.round(programs / 8)),
    run: runQueueShapeDifferential,
    minimize: (spec, signature) =>
      minimizeQueueShape(spec, signature, runQueueShapeDifferential),
  },
];

for (const family of families) {
  const specs = fc.sample(family.arb, {
    numRuns: family.programs ?? programs,
    seed,
  });
  const started = performance.now();
  const unknown = new Map();
  for (const spec of specs) {
    const result = await family.run(spec);
    if (!shapeFailed(result)) {
      continue;
    }
    for (const finding of result.findings) {
      const signature = findingSignature(finding);
      if (!KNOWN_SIGNATURES.has(signature) && !unknown.has(signature)) {
        unknown.set(signature, spec);
      }
    }
  }
  const seconds = (performance.now() - started) / 1000;
  console.log(
    `${family.name}: ${specs.length} programs in ${seconds.toFixed(1)}s (${(specs.length / (seconds / 60)).toFixed(0)}/min)`,
  );

  for (const [signature, spec] of unknown) {
    const minimal = await family.minimize(spec, signature);
    const result = await family.run(minimal);
    console.log(`\n### something nobody has written down: ${signature}`);
    console.log(formatShapeFailure(result));
    problems.push(`new finding ${signature} in the ${family.name} family`);
  }
}

// A bug that stopped reproducing is a fix somebody landed without
// promoting the dimension value. Worth failing on, because the pinned
// test is the only thing keeping the sound tier accurate.
const PLAIN_BODY = {
  props: [],
  guards: [],
  root: { type: "element", tag: "div", children: [] },
};
for (const bug of ANNOUNCEMENT_BUGS) {
  const result = await runAnnounceShapeDifferential(
    { ...SIMPLEST_ANNOUNCEMENT, bodyKey: "ok", [bug.dimension]: bug.value },
    nestPack,
  );
  if (!result.findings.map(findingSignature).includes(bug.signature)) {
    problems.push(
      `${bug.dimension}=${bug.value} no longer reports ${bug.signature}, so "${bug.wrong}" looks fixed. Promote it into the sound tier and take it out of knownBugs.ts`,
    );
  }
}

for (const bug of COMPONENT_BUGS) {
  const spec = repairComponentShape({
    form: "declaration",
    binding: "const",
    route: "namedBinding",
    body: PLAIN_BODY,
    [bug.dimension]: bug.value,
  });
  const result = await runComponentShapeDifferential(spec, pack);
  const signatures = result.findings.map(findingSignature);
  if (!signatures.includes(bug.signature)) {
    problems.push(
      `${bug.dimension}=${bug.value} no longer reports ${bug.signature}, so "${bug.wrong}" looks fixed. Promote it into the sound tier and take it out of knownBugs.ts`,
    );
  }
}

// The families whose pinned bugs are one spec each: start from the
// plainest spelling, apply the bug's dimension, and require the same
// finding the pinned test requires.
const pinnedFamilies = [
  {
    bugs: APOLLO_RESOLVER_BUGS,
    simplest: SIMPLEST_APOLLO_RESOLVER,
    run: runApolloResolverDifferential,
  },
  {
    bugs: NEST_RESOLVER_BUGS,
    simplest: SIMPLEST_NEST_RESOLVER,
    run: runNestResolverDifferential,
  },
  {
    bugs: ENV_BUGS,
    simplest: { ...SIMPLEST_ENV_SHAPE, varName: "SERVICE_URL" },
    run: runEnvShapeDifferential,
  },
  {
    bugs: QUEUE_BUGS,
    simplest: SIMPLEST_QUEUE_SHAPE,
    run: runQueueShapeDifferential,
  },
  {
    bugs: PACKAGE_BUGS,
    simplest: SIMPLEST_PACKAGE_SHAPE,
    run: runPackageShapeDifferential,
  },
];

for (const family of pinnedFamilies) {
  for (const bug of family.bugs) {
    const spec = {
      ...family.simplest,
      ...bug.alongside,
      [bug.dimension]: bug.value,
    };
    const result = await family.run(spec);
    if (!result.findings.map(findingSignature).includes(bug.signature)) {
      problems.push(
        `${bug.dimension}=${bug.value} no longer reports ${bug.signature}, so "${bug.wrong}" looks fixed. Promote it into the sound tier and take it out of knownBugs.ts`,
      );
    }
  }
}

if (problems.length > 0) {
  console.error(`\n${problems.length} things to look at:`);
  for (const problem of problems) {
    console.error(`  - ${problem}`);
  }
  process.exit(1);
}
console.log("\nnothing new, and every pinned bug still reproduces");
