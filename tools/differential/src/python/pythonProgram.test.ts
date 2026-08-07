// pythonProgram.test.ts: the renderer's own contract, held without an
// interpreter. What the intents promise about a rendered program is
// what the judge later leans on, so the promises are pinned here: one
// intent per declared route, unique names, no two intents sharing a
// served (method, path), and the expectation matching the shape's
// documented tier.

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  arbFastapiProgramSpec,
  arbFlaskProgramSpec,
  arbPythonProgramSpec,
} from "./pythonGenerators.js";
import { renderPythonProgram } from "./pythonProgram.js";

import type { PythonProgramSpec } from "./pythonProgram.js";

const SAMPLED: PythonProgramSpec[] = fc.sample(arbPythonProgramSpec, {
  numRuns: 300,
  seed: 20260806,
});

describe("renderPythonProgram", () => {
  it("gives every intent a unique name and every claim intent exactly one served path", () => {
    for (const spec of SAMPLED) {
      const rendered = renderPythonProgram(spec, "app_0");
      const names = rendered.intents.map((intent) => intent.name);
      expect(new Set(names).size).toBe(names.length);
      for (const intent of rendered.intents) {
        if (intent.expectation === "claim") {
          expect(intent.servedPaths).toHaveLength(1);
        }
      }
    }
  });

  it("never serves two intents at the same method and path", () => {
    for (const spec of SAMPLED) {
      const rendered = renderPythonProgram(spec, "app_0");
      const keys = rendered.intents.flatMap((intent) =>
        intent.servedPaths.map((path) => `${intent.method} ${path}`),
      );
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it("renders every intent's declaration into some file", () => {
    for (const spec of SAMPLED) {
      const rendered = renderPythonProgram(spec, "app_0");
      const allSource = Object.values(rendered.files).join("\n");
      for (const intent of rendered.intents) {
        const declared = intent.name.includes(".")
          ? `def ${intent.name.split(".")[1]}(`
          : `def ${intent.name}(`;
        expect(allSource).toContain(declared);
      }
    }
  });

  it("marks the fastapi abstention shapes abstain and the direct shapes claim", () => {
    const spec: PythonProgramSpec = {
      framework: "fastapi",
      program: {
        groups: [
          {
            type: "app",
            routes: [
              {
                verb: "GET",
                segment: "todos",
                hasPathParam: false,
                pathComputed: false,
                status: { type: "absent" },
                response: "none",
                hasBodyParam: false,
                hasQueryParam: false,
              },
              {
                verb: "GET",
                segment: "reports",
                hasPathParam: false,
                pathComputed: true,
                status: { type: "absent" },
                response: "none",
                hasBodyParam: false,
                hasQueryParam: false,
              },
            ],
          },
          {
            type: "unmounted",
            routes: [
              {
                verb: "GET",
                segment: "users",
                hasPathParam: false,
                pathComputed: false,
                status: { type: "absent" },
                response: "none",
                hasBodyParam: false,
                hasQueryParam: false,
              },
            ],
          },
        ],
      },
    };
    const rendered = renderPythonProgram(spec, "app_0");
    expect(
      rendered.intents.map((intent) => [
        intent.name,
        intent.expectation,
        intent.servedPaths,
      ]),
    ).toEqual([
      ["get_todos0", "claim", ["/todos0"]],
      ["get_reports1", "abstain", ["/c1/reports1"]],
      ["get_users2", "abstain", []],
    ]);
  });

  it("composes the mount and router prefixes into a mounted route's served path", () => {
    const spec: PythonProgramSpec = {
      framework: "fastapi",
      program: {
        groups: [
          {
            type: "mounted",
            ownPrefix: "literal",
            mountPrefix: "literal",
            crossFile: true,
            routes: [
              {
                verb: "POST",
                segment: "items",
                hasPathParam: false,
                pathComputed: false,
                status: { type: "literal", code: 201 },
                response: "responseModel",
                hasBodyParam: true,
                hasQueryParam: false,
              },
            ],
          },
        ],
      },
    };
    const rendered = renderPythonProgram(spec, "app_9");
    expect(rendered.intents).toEqual([
      {
        name: "post_items0",
        method: "POST",
        servedPaths: ["/m0/g0/items0"],
        expectation: "claim",
        requestBody: { id: 1, name: "x" },
      },
    ]);
    expect(Object.keys(rendered.files).sort()).toEqual([
      "app_9/__init__.py",
      "app_9/main.py",
      "app_9/routers/__init__.py",
      "app_9/routers/r0.py",
    ]);
    expect(rendered.files["app_9/main.py"]).toContain(
      'app.include_router(router_0, prefix="/m0")',
    );
    expect(rendered.files["app_9/routers/r0.py"]).toContain(
      '@router.post("/items0", status_code=201, response_model=Model0)',
    );
  });

  it("routes the flask wrapper arm through the wrapper module it names for the pack", () => {
    const sampledFlask = fc.sample(arbFlaskProgramSpec, {
      numRuns: 40,
      seed: 20260806,
    });
    for (const program of sampledFlask) {
      const rendered = renderPythonProgram(
        { framework: "flask-restx", program },
        "app_3",
      );
      if (program.importStyle === "direct") {
        expect(rendered.wrapperModules).toEqual([]);
        continue;
      }
      expect(rendered.wrapperModules).toEqual(["app_3.wrappers.restx"]);
      expect(rendered.files["app_3/wrappers/restx.py"]).toContain(
        "def route(path):",
      );
    }
  });

  it("keeps every fastapi body parameter on a verb that carries one", () => {
    const sampledFastapi = fc.sample(arbFastapiProgramSpec, {
      numRuns: 100,
      seed: 20260806,
    });
    const bodyVerbs = new Set(["POST", "PUT", "PATCH"]);
    for (const program of sampledFastapi) {
      const rendered = renderPythonProgram(
        { framework: "fastapi", program },
        "app_0",
      );
      for (const intent of rendered.intents) {
        if (intent.requestBody !== null) {
          expect(bodyVerbs.has(intent.method)).toBe(true);
        }
      }
    }
  });
});
