import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

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
  declaredDiscovery: [
    {
      kind: "handler",
      match: {
        type: "manifest",
        entries: (file) =>
          path.basename(file) === "app.py"
            ? ["handler", "wrapped", "absent", "table_name", "aliased"].map(
                (name) => ({
                  path: [name],
                  units: [
                    {
                      kind: "handler",
                      name: `Orders.${name}`,
                      deployableUnit: {
                        deploymentTarget: "lambda",
                        instanceName: "Orders",
                      },
                      ...(name === "handler"
                        ? { metadata: { entryTest: { name } } }
                        : {}),
                    },
                  ],
                }),
              )
            : [],
      },
    },
  ],
  libraryEnvVars: [
    { module: "tracing_lib", prefixes: ["TRACE_"] },
    { module: "unused_lib", prefixes: ["UNUSED_"] },
  ],
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
      "def record(event, context):",
      '    return os.environ["AUDIT_TOPIC"]',
      "",
      "aliased = record",
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

  it("follows a name bound to a def to that def, which the platform calls through the name", () => {
    const aliased = summaries.find((s) => s.identity.name === "Orders.aliased");

    expect(aliased?.kind).toBe("handler");
    expect(aliased?.identity.exportPath).toEqual(["aliased"]);
    expect(aliased?.location.range.start).toBe(10);
  });

  it("starts the call walk, so the helper it calls gets a summary", () => {
    expect(summaries.map((s) => s.identity.name)).toContain("table_name");
  });

  it("gets no unit when the module binds the name without a body, imports it, or never binds it", () => {
    const names = summaries.map((s) => s.identity.name);
    expect(names).not.toContain("Orders.wrapped");
    expect(names).not.toContain("Orders.table_name");
    expect(names).not.toContain("Orders.absent");
  });

  it("marks no library that no file in the run imports", () => {
    expect(
      summaries.some((s) => s.identity.name === "unused_lib env reads"),
    ).toBe(false);
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
