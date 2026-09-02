// Worker for scripts/dogfood.mjs: extracts one @suss/* package at a
// time and posts back the summaries. The parent keeps a few alive and
// feeds each one package after another, so ts-morph loads once per worker.

import { createHash } from "node:crypto";
import v8 from "node:v8";
import vm from "node:vm";
import { parentPort, workerData } from "node:worker_threads";

import { createTypeScriptAdapter } from "../packages/adapter/typescript/dist/index.js";

const { sussImportTargets } = workerData;

/**
 * A full collection, run between packages. V8 collects when the heap
 * nears its limit, and a thread that stays alive across packages is
 * allowed several gigabytes before that happens, so four of them peaked
 * the run at 9GB where a thread per package peaked it under 3GB.
 * Collecting once the summaries are posted keeps each thread near what
 * one package needs. The flag has to be set from inside the thread,
 * since a worker cannot take V8 flags of its own.
 */
v8.setFlagsFromString("--expose-gc");
const collectGarbage = vm.runInNewContext("gc");

// What a thread may keep after collecting. More than this means
// something retains state across packages, and a fresh thread is safer
// than finding out how far it grows.
const RETAINED_HEAP_LIMIT_MB = 512;

function packFor(pkg) {
  const name = pkg.packageJson.name;
  const pack = {
    name: `package-exports:${name}`,
    languages: ["typescript"],
    protocol: "in-process",
    discovery: [
      {
        kind: "library",
        match: {
          type: "packageExports",
          packageJsonPath: pkg.packageJsonPath,
        },
      },
      {
        kind: "caller",
        match: {
          type: "packageImport",
          packages: sussImportTargets.filter((p) => p !== name),
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
        { position: 3, role: "arg3" },
      ],
    },
  };

  // This pack is written here rather than published, so its version is
  // a hash of its own definition. Editing the pack changes the stamp.
  pack.version = createHash("sha256")
    .update(JSON.stringify(pack))
    .digest("hex")
    .slice(0, 12);
  return pack;
}

async function extract(pkg) {
  let report = null;
  const adapter = createTypeScriptAdapter({
    tsConfigFilePath: pkg.tsconfig,
    frameworks: [packFor(pkg)],
    // The dogfood counts are a gate, and reading a cache warmed by a
    // different tree can pass the wrong tree (#236). The run is rare
    // enough that extracting from scratch costs little.
    cacheDir: null,
    onExtractionReport: (r) => {
      report = r;
    },
  });
  const summaries = await adapter.extractAll();
  return { kind: "ok", summaries, report };
}

function retainedHeapMb() {
  collectGarbage();
  return v8.getHeapStatistics().used_heap_size / 1048576;
}

parentPort.on("message", async (pkg) => {
  let result;
  try {
    result = await extract(pkg);
  } catch (err) {
    result = { kind: "error", message: err.message };
  }
  parentPort.postMessage({
    ...result,
    retire: retainedHeapMb() > RETAINED_HEAP_LIMIT_MB,
  });
});
