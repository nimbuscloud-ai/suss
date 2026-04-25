// Worker for scripts/dogfood.mjs — runs the adapter for a single package
// and posts back the summaries. One worker per @suss/* package, scheduled
// by the parent with a CPU-core-sized concurrency cap.

import { parentPort, workerData } from "node:worker_threads";

import { createTypeScriptAdapter } from "../packages/adapter/typescript/dist/index.js";

const { pkg, sussImportTargets } = workerData;
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

try {
  const adapter = createTypeScriptAdapter({
    tsConfigFilePath: pkg.tsconfig,
    frameworks: [pack],
  });
  const summaries = await adapter.extractAll();
  parentPort.postMessage({ kind: "ok", summaries });
} catch (err) {
  parentPort.postMessage({ kind: "error", message: err.message });
}
