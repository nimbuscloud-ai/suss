import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  arbFastapiProgramSpec,
  arbFlaskProgramSpec,
  arbPythonProgramSpec,
} from "./pythonGenerators.js";
import { renderPythonProgram } from "./pythonProgram.js";

import type { FlaskResourceSpec, PythonProgramSpec } from "./pythonProgram.js";

function flaskResource(segment: string): FlaskResourceSpec {
  return {
    segment,
    hasPathParam: false,
    converterArgs: false,
    pathComputed: false,
    methods: [
      { verb: "GET", annotated: false, returnStyle: "dict", tupleStatus: 201 },
    ],
  };
}

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
                pathParamTyped: false,
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
                pathParamTyped: false,
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
                pathParamTyped: false,
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

  it("writes the typed and argument converter spellings while claiming the canonical brace path", () => {
    const fastapiSpec: PythonProgramSpec = {
      framework: "fastapi",
      program: {
        groups: [
          {
            type: "app",
            routes: [
              {
                verb: "GET",
                segment: "todos",
                hasPathParam: true,
                pathParamTyped: true,
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
    const fastapiRendered = renderPythonProgram(fastapiSpec, "app_7");
    expect(fastapiRendered.files["app_7/main.py"]).toContain(
      '"/todos0/{todos0_id:int}"',
    );
    expect(fastapiRendered.intents).toEqual([
      {
        name: "get_todos0",
        method: "GET",
        servedPaths: ["/todos0/{todos0_id}"],
        expectation: "claim",
        requestBody: null,
      },
    ]);

    const flaskSpec: PythonProgramSpec = {
      framework: "flask-restx",
      program: {
        importStyle: "direct",
        apiMount: { type: "app" },
        apiPrefix: { type: "absent" },
        resources: [
          {
            segment: "orders",
            hasPathParam: true,
            converterArgs: true,
            pathComputed: false,
            methods: [
              {
                verb: "GET",
                annotated: false,
                returnStyle: "dict",
                tupleStatus: 201,
              },
            ],
          },
        ],
        namespaces: [],
      },
    };
    const flaskRendered = renderPythonProgram(flaskSpec, "app_8");
    expect(flaskRendered.files["app_8/main.py"]).toContain(
      '"/orders0/<int(min=0):orders0_id>"',
    );
    expect(flaskRendered.intents).toEqual([
      {
        name: "Orders0.get",
        method: "GET",
        servedPaths: ["/orders0/{orders0_id}"],
        expectation: "claim",
        requestBody: null,
      },
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
                pathParamTyped: false,
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

  it("serves a namespace's resources under the path the namespace holds", () => {
    const spec: PythonProgramSpec = {
      framework: "flask-restx",
      program: {
        importStyle: "direct",
        apiMount: { type: "app" },
        apiPrefix: { type: "absent" },
        resources: [],
        namespaces: [
          {
            mountSite: "module",
            type: "mounted",
            path: { type: "literal", trailingSlash: true },
            mountPath: { type: "absent" },
            emptyPathResource: true,
            resources: [
              {
                segment: "orders",
                hasPathParam: false,
                converterArgs: false,
                pathComputed: false,
                methods: [
                  {
                    verb: "GET",
                    annotated: false,
                    returnStyle: "dict",
                    tupleStatus: 201,
                  },
                ],
              },
              {
                segment: "items",
                hasPathParam: true,
                converterArgs: false,
                pathComputed: false,
                methods: [
                  {
                    verb: "GET",
                    annotated: false,
                    returnStyle: "dict",
                    tupleStatus: 201,
                  },
                ],
              },
            ],
          },
        ],
      },
    };
    const rendered = renderPythonProgram(spec, "app_10");
    expect(rendered.files["app_10/namespaces/ns0.py"]).toContain(
      'ns = Namespace("ns0", path="/ns0/")',
    );
    expect(rendered.files["app_10/namespaces/ns0.py"]).toContain(
      '@ns.route("")',
    );
    expect(rendered.files["app_10/main.py"]).toContain(
      "api.add_namespace(ns_0)",
    );
    expect(rendered.intents).toEqual([
      {
        name: "Orders0.get",
        method: "GET",
        servedPaths: ["/ns0"],
        expectation: "claim",
        requestBody: null,
      },
      {
        name: "Items1.get",
        method: "GET",
        servedPaths: ["/ns0/items1/{items1_id}"],
        expectation: "claim",
        requestBody: null,
      },
    ]);
  });

  it("expects an abstention wherever the mount reading has one documented", () => {
    const spec: PythonProgramSpec = {
      framework: "flask-restx",
      program: {
        importStyle: "direct",
        apiMount: { type: "app" },
        apiPrefix: { type: "absent" },
        resources: [],
        namespaces: [
          {
            mountSite: "module",
            type: "mounted",
            path: { type: "absent" },
            mountPath: { type: "absent" },
            emptyPathResource: false,
            resources: [flaskResource("alpha")],
          },
          {
            type: "unmounted",
            resources: [flaskResource("beta")],
          },
          {
            type: "mountedTwice",
            resources: [flaskResource("gamma")],
          },
        ],
      },
    };
    const rendered = renderPythonProgram(spec, "app_11");
    expect(
      rendered.intents.map((intent) => [
        intent.name,
        intent.expectation,
        intent.servedPaths,
      ]),
    ).toEqual([
      // The library derives this path from the namespace name, which the
      // pack declines to derive.
      ["Alpha0.get", "abstain", ["/ns0/alpha0"]],
      // Never mounted, so never served at all.
      ["Beta1.get", "abstain", []],
      // Both mounts land on one path, and which one served it is not
      // written down.
      ["Gamma2.get", "abstain", ["/t2/gamma2"]],
    ]);
  });

  it("writes each registration site where the app factory shape puts it, and claims every one it can follow to a namespace", () => {
    const spec: PythonProgramSpec = {
      framework: "flask-restx",
      program: {
        importStyle: "direct",
        apiMount: { type: "app" },
        apiPrefix: { type: "absent" },
        resources: [],
        namespaces: [
          {
            type: "mounted",
            path: { type: "literal", trailingSlash: false },
            mountPath: { type: "absent" },
            mountSite: "factory",
            emptyPathResource: false,
            resources: [flaskResource("alpha")],
          },
          {
            type: "mounted",
            path: { type: "literal", trailingSlash: false },
            mountPath: { type: "absent" },
            mountSite: "loopLiteral",
            emptyPathResource: false,
            resources: [flaskResource("beta")],
          },
          {
            type: "mounted",
            path: { type: "literal", trailingSlash: false },
            mountPath: { type: "absent" },
            mountSite: "loopCall",
            emptyPathResource: false,
            resources: [flaskResource("gamma")],
          },
        ],
      },
    };
    const rendered = renderPythonProgram(spec, "app_13");
    const main = rendered.files["app_13/main.py"];
    expect(main).toContain("def register_namespaces():\n    api.add_namespace");
    expect(main).toContain(
      "    for namespace in [ns_1]:\n        api.add_namespace(namespace)",
    );
    expect(main).toContain(
      "    for namespace in load_ns_2():\n        api.add_namespace(namespace)",
    );
    expect(main).toContain("register_namespaces()");
    expect(
      rendered.intents.map((intent) => [
        intent.name,
        intent.expectation,
        intent.servedPaths,
      ]),
    ).toEqual([
      ["Alpha0.get", "claim", ["/ns0/alpha0"]],
      ["Beta1.get", "claim", ["/ns1/beta1"]],
      ["Gamma2.get", "abstain", ["/ns2/gamma2"]],
    ]);
  });

  it("renders every no-value spelling at both sites, and expects a claim wherever the library reads one", () => {
    // The library asks whether the path is truthy and nothing else.
    const spec: PythonProgramSpec = {
      framework: "flask-restx",
      program: {
        importStyle: "direct",
        apiMount: { type: "app" },
        apiPrefix: { type: "absent" },
        resources: [],
        namespaces: [
          {
            mountSite: "module",
            type: "mounted",
            path: { type: "literal", trailingSlash: false },
            mountPath: { type: "noValue", written: "none" },
            emptyPathResource: false,
            resources: [flaskResource("alpha")],
          },
          {
            mountSite: "module",
            type: "mounted",
            path: { type: "noValue", written: "false" },
            mountPath: { type: "absent" },
            emptyPathResource: false,
            resources: [flaskResource("beta")],
          },
          {
            mountSite: "module",
            type: "mounted",
            path: { type: "literal", trailingSlash: false },
            mountPath: { type: "computed" },
            emptyPathResource: false,
            resources: [flaskResource("gamma")],
          },
        ],
      },
    };
    const rendered = renderPythonProgram(spec, "app_12");
    expect(rendered.files["app_12/namespaces/ns0.py"]).toContain(
      'ns = Namespace("ns0", path="/ns0")',
    );
    expect(rendered.files["app_12/main.py"]).toContain(
      "api.add_namespace(ns_0, path=None)",
    );
    expect(rendered.files["app_12/namespaces/ns1.py"]).toContain(
      'ns = Namespace("ns1", path=False)',
    );
    expect(rendered.files["app_12/main.py"]).toContain('OVERRIDE_2 = "/mo2"');
    expect(
      rendered.intents.map((intent) => [
        intent.name,
        intent.expectation,
        intent.servedPaths,
      ]),
    ).toEqual([
      // A falsy mount path is no override, so this keeps the path its
      // constructor stated.
      ["Alpha0.get", "claim", ["/ns0/alpha0"]],
      // A falsy constructor path leaves the library deriving one from the name.
      ["Beta1.get", "abstain", ["/ns1/beta1"]],
      // A mount path nobody can read takes the namespace somewhere this
      // reading cannot follow.
      ["Gamma2.get", "abstain", ["/mo2/gamma2"]],
    ]);
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
