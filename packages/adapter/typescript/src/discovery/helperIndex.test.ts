import { describe, expect, it } from "vitest";

import { createTestProject } from "@suss/test-project";

import { ResolutionStore } from "../facts/store.js";
import { buildProjectHelperIndex } from "./helperIndex.js";
import { parameterNames, readHelperSinks } from "./helperReading.js";

import type {
  DiscoveryPattern,
  PatternPack,
  ProjectHelper,
} from "@suss/extractor";
import type { Project, SourceFile } from "ts-morph";

function projectWith(files: Record<string, string>): {
  project: Project;
  sourceFiles: SourceFile[];
} {
  const project = createTestProject();
  project.createSourceFile(
    "/node_modules/express/package.json",
    JSON.stringify({ name: "express", types: "index.d.ts" }),
  );
  project.createSourceFile(
    "/node_modules/express/index.d.ts",
    `
      export interface Express {
        get(path: string, handler: unknown): void;
        post(path: string, handler: unknown): void;
      }
      export function Router(): Express;
      declare function express(): Express;
      export default express;
    `,
  );
  const sourceFiles = Object.entries(files).map(([path, source]) =>
    project.createSourceFile(path, source),
  );
  return { project, sourceFiles };
}

/** A pack that registers with `.get`, and asks for helpers from call sites. */
function packAsking(
  declare: (helpers: readonly ProjectHelper[]) => {
    discovery?: DiscoveryPattern[];
  },
): PatternPack {
  return {
    name: "express",
    protocol: "http",
    languages: ["typescript"],
    discovery: [
      {
        kind: "handler",
        match: {
          type: "registrationCall",
          importModule: "express",
          importName: "express",
          registrationChain: [".get", ".post"],
        },
        requiresImport: ["express"],
      },
    ],
    terminals: [],
    inputMapping: { type: "positionalParams", params: [] },
    projectHelpers: { find: { by: "subject" }, declare },
  };
}

const APP = `
  import express from "express";
  import { registerCrud } from "./crud";
  const app = express();
  registerCrud(app, "users", { list() {} });
  registerCrud(app, "orders", { list() {} });
`;

const CRUD = `
  interface Sink { get(path: string, handler: unknown): void }
  export function registerCrud(sink: Sink, name: string, handlers: { list(): void }) {
    sink.get(\`/\${name}\`, handlers.list);
  }
`;

function helpersRead(files: Record<string, string>): ProjectHelper[] {
  const { sourceFiles } = projectWith(files);
  const seen: ProjectHelper[] = [];
  const pack = packAsking((helpers) => {
    seen.push(...helpers);
    return {};
  });
  const applicable = new Map(
    sourceFiles
      .filter((file) => file.getFullText().includes('from "express"'))
      .map((file) => [file, [pack]] as const),
  );
  buildProjectHelperIndex(
    sourceFiles,
    [pack],
    applicable,
    new ResolutionStore(),
  );
  return seen;
}

describe("finding a helper from the call site", () => {
  it("reads a helper whose own file never mentions the library", () => {
    const [helper] = helpersRead({ "/app.ts": APP, "/crud.ts": CRUD });

    expect(helper).toMatchObject({
      name: "registerCrud",
      file: "/crud.ts",
      parameters: ["sink", "name", "handlers"],
      subjectParameters: [0],
    });
  });

  it("says what the body registers in terms of the helper's parameters", () => {
    const [helper] = helpersRead({ "/app.ts": APP, "/crud.ts": CRUD });

    expect(helper?.sinks).toEqual([
      {
        method: "get",
        receiver: { as: "parameter", position: 0 },
        arguments: [
          { as: "text", text: "/{1}" },
          { as: "parameter", position: 2, property: "list" },
        ],
      },
    ]);
  });

  it("reads one helper once however many callers hand it the app", () => {
    expect(helpersRead({ "/app.ts": APP, "/crud.ts": CRUD })).toHaveLength(1);
  });

  it("leaves a function nothing hands the app to alone", () => {
    const helpers = helpersRead({
      "/app.ts": `
        import express from "express";
        import { logIt } from "./log";
        const app = express();
        app.get("/direct", () => {});
        logIt("hello");
      `,
      "/log.ts":
        "export function logIt(message: string) { console.log(message); }",
    });

    expect(helpers).toEqual([]);
  });

  it("costs nothing when no pack asks for one", () => {
    const { sourceFiles } = projectWith({ "/app.ts": APP, "/crud.ts": CRUD });
    const index = buildProjectHelperIndex(
      sourceFiles,
      [],
      new Map(),
      new ResolutionStore(),
    );

    expect(index.patternsFor("express")).toEqual([]);
    expect(index.contributedRecognizers()).toEqual([]);
  });
});

describe("finding a helper by what its body writes", () => {
  const WIRE = `
    export async function send(target: string, body: object) {
      return fetch("https://example.test/", {
        headers: { "X-Wire-Target": \`Service_1.\${target}\` },
        body: JSON.stringify(body),
      });
    }
  `;

  function readByText(contains: string[]): ProjectHelper[] {
    const { sourceFiles } = projectWith({ "/wire.ts": WIRE, "/other.ts": "" });
    const seen: ProjectHelper[] = [];
    const pack: PatternPack = {
      ...packAsking(() => ({})),
      projectHelpers: {
        find: { by: "text", contains },
        declare: (helpers) => {
          seen.push(...helpers);
          return {};
        },
      },
    };
    buildProjectHelperIndex(
      sourceFiles,
      [pack],
      new Map(),
      new ResolutionStore(),
    );
    return seen;
  }

  it("reads a file containing the string the pack asked about", () => {
    const [helper] = readByText(["Service_1."]);

    expect(helper?.name).toBe("send");
    expect(helper?.sinks[0]).toMatchObject({
      method: null,
      arguments: [
        { as: "text", text: "https://example.test/" },
        {
          as: "object",
          properties: {
            headers: {
              as: "object",
              properties: {
                "X-Wire-Target": { as: "text", text: "Service_1.{0}" },
              },
            },
            body: {
              as: "call",
              callee: "JSON.stringify",
              arguments: [{ as: "parameter", position: 1 }],
            },
          },
        },
      ],
    });
  });

  it("reads nothing from a project that never writes it", () => {
    expect(readByText(["Elsewhere_2."])).toEqual([]);
  });
});

describe("reading one body", () => {
  function bodyOf(source: string) {
    const { sourceFiles } = projectWith({ "/one.ts": source });
    const declaration = (sourceFiles[0] as SourceFile).getFunctions()[0];
    if (declaration === undefined) {
      throw new Error("the snippet declares no function");
    }
    return {
      parameters: parameterNames(declaration),
      sinks: readHelperSinks(declaration),
    };
  }

  it("leaves a template unread when it interpolates something else", () => {
    const { sinks } = bodyOf(`
      export function f(sink: { get(p: string, h: unknown): void }, name: string) {
        sink.get(\`/\${name.toUpperCase()}\`, () => {});
      }
    `);

    expect(sinks[0]?.arguments[0]).toEqual({ as: "unread" });
  });

  it("leaves a name that is not a parameter unread", () => {
    const { sinks } = bodyOf(`
      const PREFIX = "/health";
      export function f(sink: { get(p: string, h: unknown): void }) {
        sink.get(PREFIX, () => {});
      }
    `);

    expect(sinks[0]?.arguments[0]).toEqual({ as: "unread" });
  });

  it("reads a literal with no interpolation as itself", () => {
    const { sinks } = bodyOf(`
      export function f(sink: { get(p: string, h: unknown): void }) {
        sink.get("/health", () => {});
      }
    `);

    expect(sinks[0]?.arguments[0]).toEqual({ as: "text", text: "/health" });
  });

  it("reads a quoted property key the way it is written", () => {
    const { sinks } = bodyOf(`
      export function f(send: (init: unknown) => void, target: string) {
        send({ "X-Amz-Target": target });
      }
    `);

    expect(sinks[0]?.arguments[0]).toEqual({
      as: "object",
      properties: { "X-Amz-Target": { as: "parameter", position: 1 } },
    });
  });
});
