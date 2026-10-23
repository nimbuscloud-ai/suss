import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { functionCallBinding } from "@suss/behavioral-ir";

import { extractPythonProject, findPythonFiles } from "./project.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { PythonPack } from "./pack.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "suss-py-entry-"));

function write(rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

/** Inline rather than the shipped Lambda pack, which depends on this package. */
const entryPack: PythonPack = {
  name: "entry-inline-test-pack",
  protocol: "http",
  discovery: [],
  entryPoints: (file) =>
    path.basename(file) === "app.py"
      ? ["handler", "wrapped"].map((name) => ({
          name,
          units: [
            {
              kind: "handler",
              name: `Orders.${name}`,
              binding: functionCallBinding({
                transport: "in-process",
                recognition: "entry-inline-test-pack",
              }),
              deployableUnit: {
                deploymentTarget: "lambda",
                instanceName: "Orders",
              },
              metadata: { entryTest: { name } },
            },
          ],
        }))
      : [],
  libraryEnvVars: [{ module: "tracing_lib", prefixes: ["TRACE_"] }],
};

let summaries: BehavioralSummary[] = [];

beforeAll(async () => {
  write(
    "app.py",
    [
      "import os",
      "import tracing_lib",
      "from helpers import table_name",
      "",
      "wrapped = tracing_lib.wrap(lambda event, context: None)",
      "",
      "def handler(event, context):",
      "    return table_name()",
      "",
    ].join("\n"),
  );
  write(
    "helpers.py",
    [
      "import os",
      "",
      "def table_name():",
      '    return os.environ["TABLE_NAME"]',
      "",
    ].join("\n"),
  );
  ({ summaries } = await extractPythonProject({
    files: findPythonFiles(root),
    packs: [entryPack],
    roots: [root],
    workspaceRoot: root,
    cacheDir: null,
  }));
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("a function a deploy manifest points at", () => {
  it("gets the unit the pack describes, with its deployable unit and metadata", () => {
    const handler = summaries.find((s) => s.identity.name === "Orders.handler");

    expect(handler?.kind).toBe("handler");
    expect(handler?.identity.deployableUnit).toEqual({
      deploymentTarget: "lambda",
      instanceName: "Orders",
    });
    expect(handler?.metadata?.entryTest).toEqual({ name: "handler" });
  });

  it("starts the call walk, so the helper it calls gets a summary", () => {
    expect(summaries.map((s) => s.identity.name)).toContain("table_name");
  });

  it("gets no unit when the module binds the name without a body", () => {
    expect(summaries.some((s) => s.identity.name === "Orders.wrapped")).toBe(
      false,
    );
  });

  it("marks a library the pack says reads the environment from its own code", () => {
    const marker = summaries.find(
      (s) => s.identity.name === "tracing_lib env reads",
    );

    expect(marker?.location.file).toBe("app.py");
    expect(marker?.metadata?.libraryEnvReads).toEqual({
      module: "tracing_lib",
      prefixes: ["TRACE_"],
    });
  });
});
