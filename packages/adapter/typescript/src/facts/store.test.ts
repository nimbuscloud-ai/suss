import { type Node, type Project, type SourceFile, SyntaxKind } from "ts-morph";
import { describe, expect, it } from "vitest";

import { createTestProject } from "@suss/test-project";

import { ResolutionStore } from "./store.js";

function projectOf(files: Record<string, string>): Project {
  const project = createTestProject();
  for (const [path, contents] of Object.entries(files)) {
    project.createSourceFile(path, contents);
  }
  return project;
}

function exportValue(project: Project, file: string, name: string): Node {
  const sourceFile = project.getSourceFileOrThrow(file);
  for (const varDecl of sourceFile.getVariableDeclarations()) {
    if (varDecl.getName() === name) {
      const init = varDecl.getInitializer();
      if (init !== undefined) {
        return init;
      }
    }
  }
  throw new Error(`No exported const ${name} in ${file}`);
}

function resolvedBody(store: ResolutionStore, value: Node): string | null {
  const resolved = store.resolveCallable(value);
  return resolved === null ? null : resolved.getText().replace(/\s+/g, " ");
}

describe("resolveCallable", () => {
  it("resolves a direct function to itself", () => {
    const project = projectOf({
      "/mod.ts": `export const handler = async () => "direct";`,
    });
    const store = new ResolutionStore();

    expect(
      resolvedBody(store, exportValue(project, "/mod.ts", "handler")),
    ).toContain('"direct"');
  });

  it("follows an alias chain", () => {
    const project = projectOf({
      "/mod.ts": `
        const inner = async () => "aliased";
        const middle = inner;
        export const handler = middle;
      `,
    });
    const store = new ResolutionStore();

    expect(
      resolvedBody(store, exportValue(project, "/mod.ts", "handler")),
    ).toContain('"aliased"');
  });

  it("follows an import to the function in the other file", () => {
    const project = projectOf({
      "/impl.ts": `export const realHandler = async () => "from impl";`,
      "/mod.ts": `
        import { realHandler } from "./impl";
        export const handler = realHandler;
      `,
    });
    const store = new ResolutionStore();

    expect(
      resolvedBody(store, exportValue(project, "/mod.ts", "handler")),
    ).toContain("from impl");
  });

  it("unwraps a local wrapper factory with no configuration", () => {
    const project = projectOf({
      "/mod.ts": `
        function withAuth(fn: (event: unknown) => Promise<unknown>) {
          return async (event: unknown) => {
            return fn(event);
          };
        }
        const inner = async (event: unknown) => "wrapped";
        export const handler = withAuth(inner);
      `,
    });
    const store = new ResolutionStore();

    expect(
      resolvedBody(store, exportValue(project, "/mod.ts", "handler")),
    ).toContain('"wrapped"');
  });

  it("unwraps a factory that takes config before the handler", () => {
    const project = projectOf({
      "/mod.ts": `
        function withInstrumentation(
          config: Record<string, unknown>,
          fn: (event: unknown) => Promise<unknown>,
        ) {
          return async (event: unknown) => {
            return fn(event);
          };
        }
        export const handler = withInstrumentation(
          { name: "channel" },
          async (event: unknown) => "instrumented",
        );
      `,
    });
    const store = new ResolutionStore();

    expect(
      resolvedBody(store, exportValue(project, "/mod.ts", "handler")),
    ).toContain('"instrumented"');
  });

  it("unwraps a static class method factory", () => {
    const project = projectOf({
      "/mod.ts": `
        class Handlers {
          static withAuth(fn: (event: unknown) => Promise<unknown>) {
            return async (event: unknown) => {
              return fn(event);
            };
          }
        }
        const inner = async (event: unknown) => "protected";
        export const handler = Handlers.withAuth(inner);
      `,
    });
    const store = new ResolutionStore();

    expect(
      resolvedBody(store, exportValue(project, "/mod.ts", "handler")),
    ).toContain('"protected"');
  });

  it("unwraps two stacked wrappers", () => {
    const project = projectOf({
      "/mod.ts": `
        function withLogging(fn: (event: unknown) => Promise<unknown>) {
          return async (event: unknown) => fn(event);
        }
        function withAuth(fn: (event: unknown) => Promise<unknown>) {
          return async (event: unknown) => fn(event);
        }
        const inner = async (event: unknown) => "twice wrapped";
        export const handler = withAuth(withLogging(inner));
      `,
    });
    const store = new ResolutionStore();

    expect(
      resolvedBody(store, exportValue(project, "/mod.ts", "handler")),
    ).toContain('"twice wrapped"');
  });

  it("unwraps a wrapper imported from another file", () => {
    const project = projectOf({
      "/wrap.ts": `
        export function withAuth(fn: (event: unknown) => Promise<unknown>) {
          return async (event: unknown) => {
            return fn(event);
          };
        }
      `,
      "/mod.ts": `
        import { withAuth } from "./wrap";
        export const handler = withAuth(async () => "cross-file wrap");
      `,
    });
    const store = new ResolutionStore();

    expect(
      resolvedBody(store, exportValue(project, "/mod.ts", "handler")),
    ).toContain("cross-file wrap");
  });

  it("unwraps a declared wrapper it cannot see into", () => {
    const project = projectOf({
      "/mod.ts": `
        import * as Sentry from "@sentry/aws-serverless";
        export const handler = Sentry.wrapHandler(async () => "sentry wrapped");
      `,
    });
    const store = new ResolutionStore([
      {
        callee: "Sentry.wrapHandler",
        argument: 0,
        module: "@sentry/aws-serverless",
      },
    ]);

    expect(
      resolvedBody(store, exportValue(project, "/mod.ts", "handler")),
    ).toContain("sentry wrapped");
  });

  it("ignores a local object spelled like a declared wrapper when nothing imported the library", () => {
    const project = projectOf({
      "/mod.ts": `
        const Sentry = { wrapHandler: (fn: unknown) => "not a function" };
        export const handler = Sentry.wrapHandler(async () => "local shape");
      `,
    });
    const store = new ResolutionStore([
      {
        callee: "Sentry.wrapHandler",
        argument: 0,
        module: "@sentry/aws-serverless",
      },
    ]);

    expect(
      store.resolveCallable(exportValue(project, "/mod.ts", "handler")),
    ).toBeNull();
  });

  it("takes a declared wrapper imported by subpath", () => {
    const project = projectOf({
      "/mod.ts": `
        import * as Sentry from "@sentry/aws-serverless/esm";
        export const handler = Sentry.wrapHandler(async () => "subpath");
      `,
    });
    const store = new ResolutionStore([
      {
        callee: "Sentry.wrapHandler",
        argument: 0,
        module: "@sentry/aws-serverless",
      },
    ]);

    expect(
      resolvedBody(store, exportValue(project, "/mod.ts", "handler")),
    ).toContain("subpath");
  });

  it("takes a declared wrapper re-exported through a project barrel", () => {
    const project = projectOf({
      "/node_modules/@sentry/aws-serverless/package.json": JSON.stringify({
        name: "@sentry/aws-serverless",
        version: "1.0.0",
        types: "index.d.ts",
      }),
      "/node_modules/@sentry/aws-serverless/index.d.ts": `
        export function wrapHandler<T>(handler: T): T;
      `,
      "/sentry.ts": `export * from "@sentry/aws-serverless";`,
      "/mod.ts": `
        import * as Sentry from "./sentry";
        export const handler = Sentry.wrapHandler(async () => "via barrel");
      `,
    });
    const store = new ResolutionStore([
      {
        callee: "Sentry.wrapHandler",
        argument: 0,
        module: "@sentry/aws-serverless",
      },
    ]);

    expect(
      resolvedBody(store, exportValue(project, "/mod.ts", "handler")),
    ).toContain("via barrel");
  });

  it("takes a declared wrapper brought in with import equals", () => {
    const project = projectOf({
      "/mod.ts": `
        import Sentry = require("@sentry/aws-serverless");
        export const handler = Sentry.wrapHandler(async () => "import equals");
      `,
    });
    const store = new ResolutionStore([
      {
        callee: "Sentry.wrapHandler",
        argument: 0,
        module: "@sentry/aws-serverless",
      },
    ]);

    expect(
      resolvedBody(store, exportValue(project, "/mod.ts", "handler")),
    ).toContain("import equals");
  });

  it("ignores a local function a barrel re-exports beside the library", () => {
    const project = projectOf({
      "/node_modules/@sentry/aws-serverless/package.json": JSON.stringify({
        name: "@sentry/aws-serverless",
        version: "1.0.0",
        types: "index.d.ts",
      }),
      "/node_modules/@sentry/aws-serverless/index.d.ts": `
        export function somethingElse<T>(handler: T): T;
      `,
      "/local.ts": `
        export const wrapHandler = (fn: unknown) => async () => "local";
      `,
      "/barrel.ts": `
        export * from "@sentry/aws-serverless";
        export * from "./local";
      `,
      "/mod.ts": `
        import { wrapHandler } from "./barrel";
        export const handler = wrapHandler(async () => "inner");
      `,
    });
    const store = new ResolutionStore([
      {
        callee: "wrapHandler",
        argument: 0,
        module: "@sentry/aws-serverless",
      },
    ]);

    expect(
      store.resolveCallable(exportValue(project, "/mod.ts", "handler")),
    ).toBeNull();
  });

  it("ignores a local object annotated with the library's own type", () => {
    const project = projectOf({
      "/node_modules/@sentry/aws-serverless/package.json": JSON.stringify({
        name: "@sentry/aws-serverless",
        version: "1.0.0",
        types: "index.d.ts",
      }),
      "/node_modules/@sentry/aws-serverless/index.d.ts": `
        export interface Wrapper {
          wrapHandler(fn: unknown): unknown;
        }
      `,
      "/local.ts": `
        import type { Wrapper } from "@sentry/aws-serverless";
        export const Sentry: Wrapper = {
          wrapHandler: (fn: unknown) => async () => "local",
        };
      `,
      "/mod.ts": `
        import { Sentry } from "./local";
        export const handler = Sentry.wrapHandler(async () => "inner");
      `,
    });
    const store = new ResolutionStore([
      {
        callee: "Sentry.wrapHandler",
        argument: 0,
        module: "@sentry/aws-serverless",
      },
    ]);

    expect(
      store.resolveCallable(exportValue(project, "/mod.ts", "handler")),
    ).toBeNull();
  });

  it("takes a wrapper whose types ship separately, through a barrel", () => {
    const project = projectOf({
      "/node_modules/sentry-js/package.json": JSON.stringify({
        name: "sentry-js",
        version: "1.0.0",
      }),
      "/node_modules/@types/sentry-js/package.json": JSON.stringify({
        name: "@types/sentry-js",
        version: "1.0.0",
        types: "index.d.ts",
      }),
      "/node_modules/@types/sentry-js/index.d.ts": `
        export function wrapHandler<T>(handler: T): T;
      `,
      "/barrel.ts": `export * from "sentry-js";`,
      "/mod.ts": `
        import { wrapHandler } from "./barrel";
        export const handler = wrapHandler(async () => "typed elsewhere");
      `,
    });
    const store = new ResolutionStore([
      { callee: "wrapHandler", argument: 0, module: "sentry-js" },
    ]);

    expect(
      resolvedBody(store, exportValue(project, "/mod.ts", "handler")),
    ).toContain("typed elsewhere");
  });

  it("takes a wrapper a package declares as a global", () => {
    const project = projectOf({
      "/node_modules/@sentry/aws-serverless/package.json": JSON.stringify({
        name: "@sentry/aws-serverless",
        version: "1.0.0",
        types: "index.d.ts",
      }),
      "/node_modules/@sentry/aws-serverless/index.d.ts": `
        declare global {
          function wrapHandler<T>(handler: T): T;
        }
        export {};
      `,
      "/mod.ts": `
        import "@sentry/aws-serverless";
        export const handler = wrapHandler(async () => "global wrapper");
      `,
    });
    const store = new ResolutionStore([
      {
        callee: "wrapHandler",
        argument: 0,
        module: "@sentry/aws-serverless",
      },
    ]);

    expect(
      resolvedBody(store, exportValue(project, "/mod.ts", "handler")),
    ).toContain("global wrapper");
  });

  it("follows .bind to the bound method", () => {
    const project = projectOf({
      "/mod.ts": `
        class Handler {
          async handle(event: unknown) {
            return "bound method";
          }
        }
        const instance = new Handler();
        export const handler = instance.handle.bind(instance);
      `,
    });
    const store = new ResolutionStore();

    expect(
      resolvedBody(store, exportValue(project, "/mod.ts", "handler")),
    ).toContain("bound method");
  });

  it("unwraps a wrapper reached through a namespace import", () => {
    const project = projectOf({
      "/wrap.ts": `
        export function withAuth(fn: (event: unknown) => Promise<unknown>) {
          return async (event: unknown) => {
            return fn(event);
          };
        }
      `,
      "/mod.ts": `
        import * as w from "./wrap";
        export const handler = w.withAuth(async () => "namespace wrap");
      `,
    });
    const store = new ResolutionStore();

    expect(
      resolvedBody(store, exportValue(project, "/mod.ts", "handler")),
    ).toContain("namespace wrap");
  });

  it("resolves a default export that wraps a function", () => {
    const project = projectOf({
      "/mod.ts": `
        function withAuth(fn: (event: unknown) => Promise<unknown>) {
          return async (event: unknown) => fn(event);
        }
        const inner = async () => "default wrapped";
        export default withAuth(inner);
      `,
    });
    const store = new ResolutionStore();
    const value = project
      .getSourceFileOrThrow("/mod.ts")
      .getExportAssignmentOrThrow(() => true)
      .getExpression();

    expect(resolvedBody(store, value)).toContain("default wrapped");
  });

  it("follows a re-export of an already wrapped export", () => {
    const project = projectOf({
      "/impl.ts": `
        function withAuth(fn: (event: unknown) => Promise<unknown>) {
          return async (event: unknown) => fn(event);
        }
        export const handler = withAuth(async () => "re-exported wrap");
      `,
      "/index.ts": `export { handler } from "./impl";`,
      "/mod.ts": `
        import { handler as inner } from "./index";
        export const handler = inner;
      `,
    });
    const store = new ResolutionStore();

    expect(
      resolvedBody(store, exportValue(project, "/mod.ts", "handler")),
    ).toContain("re-exported wrap");
  });

  it("resolves a second export in a file it already extracted, walking into the imported file", () => {
    const project = projectOf({
      "/impl.ts": `export const realHandler = async () => "from impl";`,
      "/mod.ts": `
        import { realHandler } from "./impl";
        export const local = async () => "local";
        export const imported = realHandler;
      `,
    });
    const store = new ResolutionStore();

    expect(
      resolvedBody(store, exportValue(project, "/mod.ts", "local")),
    ).toContain("local");
    expect(
      resolvedBody(store, exportValue(project, "/mod.ts", "imported")),
    ).toContain("from impl");
  });

  it("gives no answer when a factory calls two of its parameters", () => {
    const project = projectOf({
      "/mod.ts": `
        function compose(
          outer: (event: unknown) => Promise<unknown>,
          inner: (event: unknown) => Promise<unknown>,
        ) {
          return async (event: unknown) => {
            await outer(event);
            return inner(event);
          };
        }
        export const handler = compose(
          async () => "outer body",
          async () => "inner body",
        );
      `,
    });
    const store = new ResolutionStore();

    expect(
      store.resolveCallable(exportValue(project, "/mod.ts", "handler")),
    ).toBeNull();
  });

  it("returns null for a value that is not a function", () => {
    const project = projectOf({
      "/mod.ts": "export const handler = 42;",
    });
    const store = new ResolutionStore();

    expect(
      store.resolveCallable(exportValue(project, "/mod.ts", "handler")),
    ).toBeNull();
  });

  it("returns null for an unresolvable wrapper", () => {
    const project = projectOf({
      "/mod.ts": `
        import { mystery } from "some-package";
        export const handler = mystery(async () => "unreachable");
      `,
    });
    const store = new ResolutionStore();

    expect(
      store.resolveCallable(exportValue(project, "/mod.ts", "handler")),
    ).toBeNull();
  });
});

describe("a name a destructuring pattern binds", () => {
  it("reads the name off the container the pattern took it apart from", () => {
    const project = projectOf({
      "/mod.ts": `
        const impl = async () => "destructured";
        const holder = { handler: impl };
        const { handler } = holder;
        export const route = handler;
      `,
    });
    const store = new ResolutionStore();

    expect(
      resolvedBody(store, exportValue(project, "/mod.ts", "route")),
    ).toContain('"destructured"');
  });

  it("follows a name the pattern renamed on the way out", () => {
    const project = projectOf({
      "/mod.ts": `
        const impl = async () => "renamed";
        const { handler: local } = { handler: impl };
        export const route = local;
      `,
    });
    const store = new ResolutionStore();

    expect(
      resolvedBody(store, exportValue(project, "/mod.ts", "route")),
    ).toContain('"renamed"');
  });

  it("takes the default where the container holds nothing under the name", () => {
    const project = projectOf({
      "/mod.ts": `
        const fallback = async () => "the default";
        const holder: { handler?: () => Promise<string> } = {};
        const { handler = fallback } = holder;
        export const route = handler;
      `,
    });
    const store = new ResolutionStore();

    expect(
      resolvedBody(store, exportValue(project, "/mod.ts", "route")),
    ).toContain("the default");
  });

  it("answers with neither where a default sits beside a value the container holds", () => {
    const project = projectOf({
      "/mod.ts": `
        const fallback = async () => "the default";
        const supplied = async () => "the supplied one";
        const holder = { handler: supplied };
        const { handler = fallback } = holder;
        export const route = handler;
      `,
    });
    const store = new ResolutionStore();

    expect(
      store.resolveCallable(exportValue(project, "/mod.ts", "route")),
    ).toBeNull();
  });

  it("follows a name a pattern bound in another module", () => {
    const project = projectOf({
      "/impl.ts": `
        const built = { handler: async () => "across modules" };
        export const { handler } = built;
      `,
      "/mod.ts": `
        import { handler } from "./impl";
        export const route = handler;
      `,
    });
    const store = new ResolutionStore();

    expect(
      resolvedBody(store, exportValue(project, "/mod.ts", "route")),
    ).toContain('"across modules"');
  });
});

describe("a function written more than once", () => {
  it("follows an overloaded function to the declaration carrying the body", () => {
    const project = projectOf({
      "/mod.ts": `
        async function impl(): Promise<string>;
        async function impl(arg: number): Promise<string>;
        async function impl(arg?: number): Promise<string> {
          return "overloaded";
        }
        export const handler = impl;
      `,
    });
    const store = new ResolutionStore();

    expect(
      resolvedBody(store, exportValue(project, "/mod.ts", "handler")),
    ).toContain('"overloaded"');
  });

  it("reads a function a declaration file declares, which has no body anywhere", () => {
    const project = projectOf({
      "/impl.d.ts": "export declare function handler(): Promise<string>;",
      "/mod.ts": `
        import { handler } from "./impl";
        export const route = handler;
      `,
    });
    const store = new ResolutionStore();

    expect(
      store.resolveCallable(exportValue(project, "/mod.ts", "route")),
    ).not.toBeNull();
  });
});

describe("a shorthand property", () => {
  it("reads the shorthand back to the function the local name holds", () => {
    const project = projectOf({
      "/mod.ts": `
        const handler = async () => "shorthand";
        const routes = { handler };
        export const route = routes.handler;
      `,
    });
    const store = new ResolutionStore();

    expect(
      resolvedBody(store, exportValue(project, "/mod.ts", "route")),
    ).toContain('"shorthand"');
  });
});

describe("a query rooted at a wrapped value", () => {
  function argumentOf(
    project: Project,
    file: string,
    callee: string,
    position: number,
  ): Node {
    const call = project
      .getSourceFileOrThrow(file)
      .getDescendantsOfKind(SyntaxKind.CallExpression)
      .find((candidate) => candidate.getExpression().getText() === callee);
    if (call === undefined) {
      throw new Error(`No call to ${callee} in ${file}`);
    }
    return call.getArguments()[position] as Node;
  }

  it("resolves a handler argument written with a cast", () => {
    const project = projectOf({
      "/mod.ts": `
        type H = () => Promise<string>;
        const local = async () => "cast handler";
        app.get("/x", local as H);
      `,
    });
    const store = new ResolutionStore();

    expect(
      resolvedBody(store, argumentOf(project, "/mod.ts", "app.get", 1)),
    ).toContain("cast handler");
  });

  it("resolves a route object argument written with `as const`", () => {
    const project = projectOf({
      "/contract.ts": `export const route = { method: "get", path: "/x" };`,
      "/mod.ts": `
        import { route } from "./contract";
        app.openapi(route as const, async () => "h");
      `,
    });
    const store = new ResolutionStore();
    const resolved = store.resolveObject(
      argumentOf(project, "/mod.ts", "app.openapi", 0),
    );

    expect(resolved?.getText()).toContain('path: "/x"');
  });
});

describe("filesImportingTransitively", () => {
  function reaches(
    store: ResolutionStore,
    file: SourceFile,
    packages: string[],
  ): boolean {
    return store
      .filesImportingTransitively([{ sourceFiles: [file], packages }])[0]
      .has(file);
  }

  it("sees a direct import", () => {
    const project = projectOf({
      "/mod.ts": `import { SendMessageCommand } from "@aws-sdk/client-sqs";`,
    });
    const store = new ResolutionStore();

    expect(
      reaches(store, project.getSourceFileOrThrow("/mod.ts"), [
        "@aws-sdk/client-sqs",
      ]),
    ).toBe(true);
  });

  it("sees a package through a project-local barrel", () => {
    const project = projectOf({
      "/aws/sqs.ts": `export { SendMessageCommand } from "@aws-sdk/client-sqs";`,
      "/service.ts": `
        import { SendMessageCommand } from "./aws/sqs";
        export const send = () => new SendMessageCommand({});
      `,
    });
    const store = new ResolutionStore();

    expect(
      reaches(store, project.getSourceFileOrThrow("/service.ts"), [
        "@aws-sdk/client-sqs",
      ]),
    ).toBe(true);
  });

  it("sees a package through export * chains", () => {
    const project = projectOf({
      "/aws/deep.ts": `export * from "@aws-sdk/client-sqs";`,
      "/aws/index.ts": `export * from "./deep";`,
      "/service.ts": `import { SendMessageCommand } from "./aws/index";`,
    });
    const store = new ResolutionStore();

    expect(
      reaches(store, project.getSourceFileOrThrow("/service.ts"), [
        "@aws-sdk/client-sqs",
      ]),
    ).toBe(true);
  });

  it("matches a subpath import of the target package", () => {
    const project = projectOf({
      "/mod.ts": `import { thing } from "@aws-sdk/client-sqs/internals";`,
    });
    const store = new ResolutionStore();

    expect(
      reaches(store, project.getSourceFileOrThrow("/mod.ts"), [
        "@aws-sdk/client-sqs",
      ]),
    ).toBe(true);
  });

  it("says no when nothing reaches the package", () => {
    const project = projectOf({
      "/other.ts": "export const x = 1;",
      "/mod.ts": `import { x } from "./other";`,
    });
    const store = new ResolutionStore();

    expect(
      reaches(store, project.getSourceFileOrThrow("/mod.ts"), [
        "@aws-sdk/client-sqs",
      ]),
    ).toBe(false);
  });

  it("answers every file in the set from one pass", () => {
    const project = projectOf({
      "/aws/sqs.ts": `export { SendMessageCommand } from "@aws-sdk/client-sqs";`,
      "/mid.ts": `export { SendMessageCommand } from "./aws/sqs";`,
      "/service.ts": `import { SendMessageCommand } from "./mid";`,
      "/unrelated.ts": "export const x = 1;",
    });
    const store = new ResolutionStore();
    const files = project.getSourceFiles();

    const [reaching] = store.filesImportingTransitively([
      { sourceFiles: files, packages: ["@aws-sdk/client-sqs"] },
    ]);

    expect([...reaching].map((f) => f.getFilePath()).sort()).toEqual([
      "/aws/sqs.ts",
      "/mid.ts",
      "/service.ts",
    ]);
  });

  it("answers the same file twice the same way", () => {
    const project = projectOf({
      "/aws/sqs.ts": `export { SendMessageCommand } from "@aws-sdk/client-sqs";`,
      "/service.ts": `import { SendMessageCommand } from "./aws/sqs";`,
    });
    const store = new ResolutionStore();
    const file = project.getSourceFileOrThrow("/service.ts");

    expect(reaches(store, file, ["@aws-sdk/client-sqs"])).toBe(true);
    expect(reaches(store, file, ["@aws-sdk/client-sqs"])).toBe(true);
  });

  it("carries an answer up to a file asked about later", () => {
    const project = projectOf({
      "/aws/sqs.ts": `export { SendMessageCommand } from "@aws-sdk/client-sqs";`,
      "/mid.ts": `export { SendMessageCommand } from "./aws/sqs";`,
      "/service.ts": `import { SendMessageCommand } from "./mid";`,
    });
    const store = new ResolutionStore();
    const gates = ["@aws-sdk/client-sqs"];

    expect(reaches(store, project.getSourceFileOrThrow("/mid.ts"), gates)).toBe(
      true,
    );
    expect(
      reaches(store, project.getSourceFileOrThrow("/service.ts"), gates),
    ).toBe(true);
  });

  it("keeps a no for every file the earlier ask covered", () => {
    const project = projectOf({
      "/leaf.ts": "export const x = 1;",
      "/mid.ts": `export { x } from "./leaf";`,
      "/service.ts": `import { x } from "./mid";`,
    });
    const store = new ResolutionStore();
    const gates = ["@aws-sdk/client-sqs"];

    expect(
      reaches(store, project.getSourceFileOrThrow("/service.ts"), gates),
    ).toBe(false);
    expect(reaches(store, project.getSourceFileOrThrow("/mid.ts"), gates)).toBe(
      false,
    );
  });

  it("answers a package nobody asked about until now", () => {
    const project = projectOf({
      "/mid.ts": `export { Client } from "@aws-sdk/client-s3";`,
      "/service.ts": `import { Client } from "./mid";`,
    });
    const store = new ResolutionStore();
    const service = project.getSourceFileOrThrow("/service.ts");

    expect(reaches(store, service, ["@aws-sdk/client-sqs"])).toBe(false);
    expect(reaches(store, service, ["@aws-sdk/client-s3"])).toBe(true);
  });

  it("walks a cycle without looping", () => {
    const project = projectOf({
      "/a.ts": `import { b } from "./b"; export const a = b;`,
      "/b.ts": `import { a } from "./a"; export const b = a;`,
    });
    const store = new ResolutionStore();

    expect(
      reaches(store, project.getSourceFileOrThrow("/a.ts"), [
        "@aws-sdk/client-sqs",
      ]),
    ).toBe(false);
  });
});

describe("resolveWrittenValue", () => {
  function usageOf(project: Project, file: string, name: string): Node {
    const sourceFile = project.getSourceFileOrThrow(file);
    const found = sourceFile
      .getDescendantsOfKind(SyntaxKind.CallExpression)
      .flatMap((call) => call.getArguments())
      .find((arg) => arg.getText() === name);
    if (found === undefined) {
      throw new Error(`No use of ${name} in ${file}`);
    }
    return found;
  }

  it("follows a name to the tag call it is written as", () => {
    const project = projectOf({
      "/mod.ts": `
        declare function gql(source: string): unknown;
        declare function run(doc: unknown): void;
        const DOC = gql(\`query WidgetSettings { widgetSettings { id } }\`);
        export function go() { run(DOC); }
      `,
    });
    const store = new ResolutionStore();

    const written = store.resolveWrittenValue(
      usageOf(project, "/mod.ts", "DOC"),
    );
    expect(written?.getText()).toContain("query WidgetSettings");
  });

  it("follows a name across a module boundary and a barrel", () => {
    const project = projectOf({
      "/documents.ts": `
        declare function gql(source: string): unknown;
        export const DOC = gql(\`query WidgetSettings { widgetSettings { id } }\`);
      `,
      "/barrel.ts": `export { DOC } from "./documents.js";`,
      "/mod.ts": `
        import { DOC } from "./barrel.js";
        declare function run(doc: unknown): void;
        export function go() { run(DOC); }
      `,
    });
    const store = new ResolutionStore();

    const written = store.resolveWrittenValue(
      usageOf(project, "/mod.ts", "DOC"),
    );
    expect(written?.getText()).toContain("query WidgetSettings");
  });

  it("answers with the object literal a name holds", () => {
    const project = projectOf({
      "/mod.ts": `
        declare function run(doc: unknown): void;
        const DOC = { kind: "Document" };
        export function go() { run(DOC); }
      `,
    });
    const store = new ResolutionStore();

    const written = store.resolveWrittenValue(
      usageOf(project, "/mod.ts", "DOC"),
    );
    expect(written?.getText()).toContain("Document");
  });

  it("answers with the computing expression when a value is decided at runtime", () => {
    const project = projectOf({
      "/mod.ts": `
        declare function gql(source: string): unknown;
        declare function run(doc: unknown): void;
        declare const legacy: boolean;
        const A = gql(\`query A { a }\`);
        const B = gql(\`query B { b }\`);
        const DOC = legacy ? A : B;
        export function go() { run(DOC); }
      `,
    });
    const store = new ResolutionStore();

    const written = store.resolveWrittenValue(
      usageOf(project, "/mod.ts", "DOC"),
    );
    expect(written?.getKindName()).toBe("ConditionalExpression");
  });

  const PRESIGNER = {
    "/sdk.ts":
      "export class GetObjectCommand { constructor(input: unknown) {} }",
    "/mod.ts": `
      import { GetObjectCommand } from "./sdk.js";
      declare function getSignedUrl(client: unknown, command: unknown): string;
      declare const client: unknown;
      export function urlFor(key: string) {
        const command = new GetObjectCommand({ Bucket: "uploads", Key: key });
        return getSignedUrl(client, command);
      }
    `,
  };

  it("gives the construction a name was written as, not the class it makes one of", () => {
    const project = projectOf(PRESIGNER);
    const store = new ResolutionStore();

    const written = store.resolveWrittenValue(
      usageOf(project, "/mod.ts", "command"),
    );
    expect(written?.getKindName()).toBe("NewExpression");
  });

  it("gives that same answer after an unrelated query widened the walk", () => {
    const project = projectOf(PRESIGNER);
    const store = new ResolutionStore();

    // Nothing settles the client, so this walks out over the imports of
    // the file and extracts the class the command is made from.
    expect(
      store.resolveWrittenValue(usageOf(project, "/mod.ts", "client")),
    ).toBeNull();

    const written = store.resolveWrittenValue(
      usageOf(project, "/mod.ts", "command"),
    );
    expect(written?.getKindName()).toBe("NewExpression");
  });
});

describe("an answer, whatever was asked before it", () => {
  const TWO_BRANCHES = {
    "/impl.ts": `export const remote = async () => "remote";`,
    "/mod.ts": `
      import { remote } from "./impl.js";
      const local: (() => Promise<string>) | undefined = async () => "local";
      export const handler = local || remote;
    `,
  };

  it("gives every source of a fallback whose other branch is imported", () => {
    const project = projectOf(TWO_BRANCHES);
    const store = new ResolutionStore();

    const value = exportValue(project, "/mod.ts", "handler");
    expect(store.resolveCallableSources(value)).toHaveLength(2);
    expect(store.resolveCallable(value)).toBeNull();
  });

  it("gives the same sources after an earlier query extracted the imported file", () => {
    const project = projectOf(TWO_BRANCHES);
    const cold = new ResolutionStore();
    const warm = new ResolutionStore();
    warm.resolveCallable(exportValue(project, "/impl.ts", "remote"));

    const value = exportValue(project, "/mod.ts", "handler");
    expect(warm.resolveCallableSources(value)).toHaveLength(2);
    expect(cold.resolveCallableSources(value)).toHaveLength(2);
  });
});

describe("a value written as a fallback", () => {
  function usedAs(project: Project, file: string, name: string): Node {
    const sourceFile = project.getSourceFileOrThrow(file);
    const found = sourceFile
      .getDescendantsOfKind(SyntaxKind.CallExpression)
      .flatMap((call) => call.getArguments())
      .find((arg) => arg.getText() === name);
    if (found === undefined) {
      throw new Error(`No use of ${name} in ${file}`);
    }
    return found;
  }

  it("resolves the branch that resolves when the other is a global cache", () => {
    const project = projectOf({
      "/mod.ts": `
        export const handler = (globalThis as any).cached || (async () => "built");
      `,
    });
    const store = new ResolutionStore();

    expect(
      resolvedBody(store, exportValue(project, "/mod.ts", "handler")),
    ).toContain('"built"');
  });

  it("answers with the construction a client singleton falls back to", () => {
    const project = projectOf({
      "/client.ts": `
        import { Client } from "client-lib";
        export const client = (globalThis as any).cachedClient || new Client();
      `,
      "/mod.ts": `
        import { client } from "./client.js";
        declare function run(c: unknown): void;
        export function go() { run(client); }
      `,
    });
    const store = new ResolutionStore();

    const written = store.resolveWrittenValue(
      usedAs(project, "/mod.ts", "client"),
    );
    expect(written?.getText()).toBe("new Client()");
  });

  it("answers with the default a config read falls back to", () => {
    const project = projectOf({
      "/mod.ts": `
        declare function run(name: string): void;
        const TABLE = process.env.TABLE ?? "orders-prod";
        export function go() { run(TABLE); }
      `,
    });
    const store = new ResolutionStore();

    const written = store.resolveWrittenValue(
      usedAs(project, "/mod.ts", "TABLE"),
    );
    expect(written?.getText()).toBe('"orders-prod"');
  });

  it("gives every source and no single answer when both branches resolve", () => {
    const project = projectOf({
      "/mod.ts": `
        const primary: (() => string) | undefined = () => "primary";
        const secondary = () => "secondary";
        export const handler = primary || secondary;
      `,
    });
    const store = new ResolutionStore();

    const value = exportValue(project, "/mod.ts", "handler");
    expect(store.resolveCallableSources(value)).toHaveLength(2);
    expect(store.resolveCallable(value)).toBeNull();
  });
});

describe("a binding written more than once", () => {
  function bindingOf(project: Project, file: string, name: string): Node {
    return project
      .getSourceFileOrThrow(file)
      .getVariableDeclarationOrThrow(name);
  }

  it("resolves to the last write when the module writes it straight through", () => {
    const project = projectOf({
      "/mod.ts": `
        function later() { return "later"; }
        let handler = () => "first";
        handler = later;
        export { handler };
      `,
    });
    const store = new ResolutionStore();

    expect(
      resolvedBody(store, bindingOf(project, "/mod.ts", "handler")),
    ).toContain('"later"');
  });

  it("resolves to nothing when a branch decides which write runs", () => {
    const project = projectOf({
      "/mod.ts": `
        declare const useLater: boolean;
        function later() { return "later"; }
        let handler = () => "first";
        if (useLater) { handler = later; }
        export { handler };
      `,
    });
    const store = new ResolutionStore();

    expect(resolvedBody(store, bindingOf(project, "/mod.ts", "handler"))).toBe(
      null,
    );
  });

  it("resolves to nothing when a function body does the writing", () => {
    const project = projectOf({
      "/mod.ts": `
        function later() { return "later"; }
        let handler = () => "first";
        export function install() { handler = later; }
        export { handler };
      `,
    });
    const store = new ResolutionStore();

    expect(resolvedBody(store, bindingOf(project, "/mod.ts", "handler"))).toBe(
      null,
    );
  });

  it("resolves to nothing when a loop writes it", () => {
    const project = projectOf({
      "/mod.ts": `
        declare const steps: Array<() => string>;
        let handler = () => "first";
        for (const step of steps) { handler = step; }
        export { handler };
      `,
    });
    const store = new ResolutionStore();

    expect(resolvedBody(store, bindingOf(project, "/mod.ts", "handler"))).toBe(
      null,
    );
  });

  it("resolves to nothing when the module reads it before the last write", () => {
    const project = projectOf({
      "/mod.ts": `
        declare function register(fn: unknown): void;
        function later() { return "later"; }
        let handler = () => "first";
        register(handler);
        handler = later;
        export { handler };
      `,
    });
    const store = new ResolutionStore();

    expect(resolvedBody(store, bindingOf(project, "/mod.ts", "handler"))).toBe(
      null,
    );
  });

  it("reads a document off the write that survives", () => {
    const project = projectOf({
      "/mod.ts": `
        declare function gql(source: string): unknown;
        let DOC = gql(\`query First { first }\`);
        DOC = gql(\`query Second { second }\`);
        export { DOC };
      `,
    });
    const store = new ResolutionStore();

    const written = store.resolveWrittenValue(
      bindingOf(project, "/mod.ts", "DOC"),
    );
    expect(written?.getText()).toContain("query Second");
  });

  it("resolves to the construction when a guard writes it once behind a check", () => {
    const project = projectOf({
      "/mod.ts": `
        declare class Client {}
        let cachedClient: Client | null = null;
        function client() {
          if (!cachedClient) {
            cachedClient = new Client();
          }
          return cachedClient;
        }
        export { cachedClient };
      `,
    });
    const store = new ResolutionStore();

    const written = store.resolveWrittenValue(
      bindingOf(project, "/mod.ts", "cachedClient"),
    );
    expect(written?.getText()).toBe("new Client()");
  });

  it("resolves to the construction when a guard writes it once with ??=", () => {
    const project = projectOf({
      "/mod.ts": `
        declare class Client {}
        let cachedClient: Client | null = null;
        function client() {
          cachedClient ??= new Client();
          return cachedClient;
        }
        export { cachedClient };
      `,
    });
    const store = new ResolutionStore();

    const written = store.resolveWrittenValue(
      bindingOf(project, "/mod.ts", "cachedClient"),
    );
    expect(written?.getText()).toBe("new Client()");
  });

  it("resolves to nothing when the guarded writes are different constructions", () => {
    const project = projectOf({
      "/mod.ts": `
        declare const useAlternate: boolean;
        declare class Client {}
        declare class OtherClient {}
        let cachedClient: unknown = null;
        if (useAlternate) {
          cachedClient = new OtherClient();
        } else {
          cachedClient = new Client();
        }
        export { cachedClient };
      `,
    });
    const store = new ResolutionStore();

    expect(
      store.resolveWrittenValue(bindingOf(project, "/mod.ts", "cachedClient")),
    ).toBe(null);
  });

  it("resolves to nothing when every write past the declaration is a null placeholder", () => {
    const project = projectOf({
      "/mod.ts": `
        declare const flag: boolean;
        let cachedClient: unknown = null;
        if (flag) {
          cachedClient = null;
        }
        export { cachedClient };
      `,
    });
    const store = new ResolutionStore();

    expect(
      store.resolveWrittenValue(bindingOf(project, "/mod.ts", "cachedClient")),
    ).toBe(null);
  });
});

describe("a call reached through a cached-client wrapper", () => {
  it("resolves to the construction the wrapper's guard settles on", () => {
    const project = projectOf({
      "/docClient.ts": `
        declare class DynamoDBDocumentClient {
          static from(base: unknown): DynamoDBDocumentClient;
          send(command: unknown): unknown;
        }
        declare function baseClient(): unknown;

        let cachedDocClient: DynamoDBDocumentClient | null = null;

        export function docClient() {
          if (!cachedDocClient) {
            cachedDocClient = DynamoDBDocumentClient.from(baseClient());
          }
          return cachedDocClient;
        }
      `,
      "/handlers.ts": `
        import { docClient } from "./docClient";
        declare class GetCommand {
          constructor(input: unknown);
        }
        function handler() {
          return docClient().send(new GetCommand({}));
        }
      `,
    });
    const store = new ResolutionStore();

    // What a storage pack asks of a call like this: which function the
    // receiver's callee calls, then what that function's return value
    // was written as.
    const receiverCallee = project
      .getSourceFileOrThrow("/handlers.ts")
      .getDescendantsOfKind(SyntaxKind.CallExpression)
      .find((call) => call.getExpression().getText() === "docClient")
      ?.getExpression();
    const wrapper = store.resolveCallable(receiverCallee as Node);
    const returned = wrapper
      ?.getDescendantsOfKind(SyntaxKind.ReturnStatement)
      .find((statement) => statement.getExpression() !== undefined)
      ?.getExpression();

    expect(
      returned && store.resolveWrittenValue(returned as Node)?.getText(),
    ).toBe("DynamoDBDocumentClient.from(baseClient())");
  });
});

describe("resolveWrittenValue on a call whose receiver is itself a call", () => {
  function callNamed(project: Project, file: string, calleeText: string): Node {
    const call = project
      .getSourceFileOrThrow(file)
      .getDescendantsOfKind(SyntaxKind.CallExpression)
      .find((c) => c.getExpression().getText() === calleeText);
    if (call === undefined) {
      throw new Error(`No call to ${calleeText} in ${file}`);
    }
    return call;
  }

  it("resolves to the construction a guarded wrapper's guard settles on", () => {
    const project = projectOf({
      "/docClient.ts": `
        declare class DynamoDBDocumentClient {
          static from(base: unknown): DynamoDBDocumentClient;
        }
        declare function baseClient(): unknown;

        let cachedDocClient: DynamoDBDocumentClient | null = null;

        export function docClient() {
          if (!cachedDocClient) {
            cachedDocClient = DynamoDBDocumentClient.from(baseClient());
          }
          return cachedDocClient;
        }
      `,
      "/handlers.ts": `
        import { docClient } from "./docClient";
        function handler() {
          return docClient();
        }
      `,
    });
    const store = new ResolutionStore();

    expect(
      store
        .resolveWrittenValue(callNamed(project, "/handlers.ts", "docClient"))
        ?.getText(),
    ).toBe("DynamoDBDocumentClient.from(baseClient())");
  });

  it("resolves to the construction a wrapper returns fresh", () => {
    const project = projectOf({
      "/client.ts": `
        declare class Client {
          static create(): Client;
        }
        export function client() {
          return Client.create();
        }
      `,
      "/handlers.ts": `
        import { client } from "./client";
        function handler() {
          return client();
        }
      `,
    });
    const store = new ResolutionStore();

    expect(
      store
        .resolveWrittenValue(callNamed(project, "/handlers.ts", "client"))
        ?.getText(),
    ).toBe("Client.create()");
  });

  it("resolves to the construction a wrapper returns from a module const", () => {
    const project = projectOf({
      "/client.ts": `
        declare class Client {
          static create(): Client;
        }
        const shared = Client.create();
        export function client() {
          return shared;
        }
      `,
      "/handlers.ts": `
        import { client } from "./client";
        function handler() {
          return client();
        }
      `,
    });
    const store = new ResolutionStore();

    expect(
      store
        .resolveWrittenValue(callNamed(project, "/handlers.ts", "client"))
        ?.getText(),
    ).toBe("Client.create()");
  });

  it("resolves to nothing when a wrapper returns one of its own parameters", () => {
    const project = projectOf({
      "/pick.ts": `
        export function pick(a?: unknown) {
          return a;
        }
      `,
      "/handlers.ts": `
        import { pick } from "./pick";
        function handler() {
          return pick();
        }
      `,
    });
    const store = new ResolutionStore();

    expect(
      store.resolveWrittenValue(callNamed(project, "/handlers.ts", "pick")),
    ).toBe(null);
  });
});

describe("a binding declared without a value", () => {
  function bindingFor(project: Project, file: string, name: string): Node {
    return project
      .getSourceFileOrThrow(file)
      .getVariableDeclarationOrThrow(name);
  }

  it("resolves to the write when the module makes it straight through", () => {
    const project = projectOf({
      "/mod.ts": `
        function later() { return "later"; }
        let handler;
        handler = later;
        export { handler };
      `,
    });
    const store = new ResolutionStore();

    expect(
      resolvedBody(store, bindingFor(project, "/mod.ts", "handler")),
    ).toContain('"later"');
  });

  it("resolves to nothing when the write sits under a branch", () => {
    const project = projectOf({
      "/mod.ts": `
        declare const flag: boolean;
        function later() { return "later"; }
        let handler;
        if (flag) { handler = later; }
        export { handler };
      `,
    });
    const store = new ResolutionStore();

    expect(resolvedBody(store, bindingFor(project, "/mod.ts", "handler"))).toBe(
      null,
    );
  });
});

describe("importedNamesOf", () => {
  it("names the library export a project wrapper stands for", () => {
    const project = projectOf({
      "/section.ts": `
        import { Controller } from "@nestjs/common";
        export const Section = (path: string) => Controller(path);
      `,
    });
    const store = new ResolutionStore();
    const wrapper = project
      .getSourceFileOrThrow("/section.ts")
      .getDescendantsOfKind(SyntaxKind.CallExpression)[0];

    expect(
      store.importedNamesOf(wrapper.getExpression(), ["@nestjs/common"]),
    ).toEqual(["Controller"]);
  });

  it("says nothing about a module nobody asked about", () => {
    const project = projectOf({
      "/section.ts": `
        import { Controller } from "@other/pkg";
        export const Section = (path: string) => Controller(path);
      `,
    });
    const store = new ResolutionStore();
    const wrapper = project
      .getSourceFileOrThrow("/section.ts")
      .getDescendantsOfKind(SyntaxKind.CallExpression)[0];

    expect(
      store.importedNamesOf(wrapper.getExpression(), ["@nestjs/common"]),
    ).toEqual([]);
  });
});

describe("a class field", () => {
  function fieldValue(project: Project, file: string, property: string): Node {
    const sourceFile = project.getSourceFileOrThrow(file);
    for (const access of sourceFile.getDescendantsOfKind(
      SyntaxKind.PropertyAccessExpression,
    )) {
      if (
        access.getName() === property &&
        access.getExpression().getKind() === SyntaxKind.ThisKeyword &&
        access.getParent()?.getKind() !== SyntaxKind.BinaryExpression
      ) {
        return access;
      }
    }
    throw new Error(`No read of this.${property} in ${file}`);
  }

  function written(store: ResolutionStore, value: Node): string | null {
    const resolved = store.resolveWrittenValue(value);
    return resolved === null ? null : resolved.getText();
  }

  it("reads a field the constructor sets", () => {
    const project = projectOf({
      "/dao.ts": `
        export class OrdersDao {
          private readonly tableName: string;
          constructor(stage: string) {
            this.tableName = stage + "-orders-v1";
          }
          find() {
            return { TableName: this.tableName };
          }
        }
      `,
    });
    const store = new ResolutionStore();

    expect(written(store, fieldValue(project, "/dao.ts", "tableName"))).toBe(
      'stage + "-orders-v1"',
    );
  });

  it("reads a field its own declaration sets", () => {
    const project = projectOf({
      "/dao.ts": `
        export class OrdersDao {
          private readonly tableName = "orders-v1";
          find() {
            return { TableName: this.tableName };
          }
        }
      `,
    });
    const store = new ResolutionStore();

    expect(written(store, fieldValue(project, "/dao.ts", "tableName"))).toBe(
      '"orders-v1"',
    );
  });

  it("takes the constructor's value over the declaration's, since it runs after", () => {
    const project = projectOf({
      "/dao.ts": `
        export class OrdersDao {
          private tableName = "unset";
          constructor(stage: string) {
            this.tableName = stage + "-orders-v1";
          }
          find() {
            return { TableName: this.tableName };
          }
        }
      `,
    });
    const store = new ResolutionStore();

    expect(written(store, fieldValue(project, "/dao.ts", "tableName"))).toBe(
      'stage + "-orders-v1"',
    );
  });

  it("reads a template literal the constructor builds, which is what a name with a stage prefix is", () => {
    const project = projectOf({
      "/dao.ts": `
        export class OrdersDao {
          private readonly tableName: string;
          constructor(stage: string) {
            this.tableName = \`\${stage}-orders-v1\`;
          }
          find() {
            return { TableName: this.tableName };
          }
        }
      `,
    });
    const store = new ResolutionStore();

    expect(written(store, fieldValue(project, "/dao.ts", "tableName"))).toBe(
      "`${stage}-orders-v1`",
    );
  });

  it("reads nothing from a field the constructor takes straight from a parameter, which says nothing about its value", () => {
    const project = projectOf({
      "/dao.ts": `
        export class OrdersDao {
          private readonly tableName: string;
          constructor(tableName: string) {
            this.tableName = tableName;
          }
          find() {
            return { TableName: this.tableName };
          }
        }
      `,
    });
    const store = new ResolutionStore();

    expect(
      written(store, fieldValue(project, "/dao.ts", "tableName")),
    ).toBeNull();
  });

  it("reads nothing from a field a method writes, which runs whenever it is called", () => {
    const project = projectOf({
      "/dao.ts": `
        export class OrdersDao {
          private tableName = "orders-v1";
          rename(next: string) {
            this.tableName = next;
          }
          find() {
            return { TableName: this.tableName };
          }
        }
      `,
    });
    const store = new ResolutionStore();

    expect(
      written(store, fieldValue(project, "/dao.ts", "tableName")),
    ).toBeNull();
  });

  it("reads nothing from a field the constructor sets inside a branch", () => {
    const project = projectOf({
      "/dao.ts": `
        export class OrdersDao {
          private tableName: string;
          constructor(stage: string) {
            if (stage === "prod") {
              this.tableName = "orders-prod";
            } else {
              this.tableName = "orders-dev";
            }
          }
          find() {
            return { TableName: this.tableName };
          }
        }
      `,
    });
    const store = new ResolutionStore();

    expect(
      written(store, fieldValue(project, "/dao.ts", "tableName")),
    ).toBeNull();
  });

  it("keeps two classes' same-named fields apart", () => {
    const project = projectOf({
      "/dao.ts": `
        export class OrdersDao {
          private readonly tableName: string;
          constructor() {
            this.tableName = "orders-v1";
          }
          find() {
            return { TableName: this.tableName };
          }
        }
        export class InvoicesDao {
          private readonly tableName: string;
          constructor() {
            this.tableName = "invoices-v1";
          }
        }
      `,
    });
    const store = new ResolutionStore();

    expect(written(store, fieldValue(project, "/dao.ts", "tableName"))).toBe(
      '"orders-v1"',
    );
  });
});

// Two files rather than one, because a service takes its dependency as
// an interface and the class behind it lives somewhere else.
const READER = `
  export interface OrdersReader {
    findByCustomer(id: string): Promise<string>;
  }
  export class OrdersDao implements OrdersReader {
    async findByCustomer(id: string): Promise<string> {
      return "orders:" + id;
    }
  }
  export class InvoicesDao implements OrdersReader {
    async findByCustomer(id: string): Promise<string> {
      return "invoices:" + id;
    }
  }
`;

/** The callee of the call a named method makes. */
function calleeIn(project: Project, file: string, method: string): Node {
  const sourceFile = project.getSourceFileOrThrow(file);
  for (const call of sourceFile.getDescendantsOfKind(
    SyntaxKind.CallExpression,
  )) {
    const owner = call.getFirstAncestorByKind(SyntaxKind.MethodDeclaration);
    if (owner?.getName() === method) {
      return call.getExpression();
    }
  }
  throw new Error(`No call inside ${method} in ${file}`);
}

describe("a dependency the constructor was handed", () => {
  function serviceProject(service: string, construction: string): Project {
    return projectOf({
      "/dao.ts": READER,
      "/service.ts": service,
      "/entry.ts": `
        import { OrdersDao, InvoicesDao } from "./dao";
        import { OrdersService } from "./service";
        export const handler = async (id: string) => {
          const service = new OrdersService(${construction});
          return service.forCustomer(id);
        };
      `,
    });
  }

  /**
   * A run reads the file a unit was discovered in before it walks into
   * the service, so the construction site's facts are already there.
   */
  function storeThatRead(project: Project): ResolutionStore {
    const store = new ResolutionStore();
    store.resolveCallable(exportValue(project, "/entry.ts", "handler"));
    return store;
  }

  it("follows a call through a parameter property to the class that was constructed", () => {
    const project = serviceProject(
      `
        import type { OrdersReader } from "./dao";
        export class OrdersService {
          constructor(private readonly dao: OrdersReader) {}
          async forCustomer(id: string) {
            return this.dao.findByCustomer(id);
          }
        }
      `,
      "new OrdersDao()",
    );

    expect(
      resolvedBody(
        storeThatRead(project),
        calleeIn(project, "/service.ts", "forCustomer"),
      ),
    ).toContain('"orders:"');
  });

  it("follows a call through a field the constructor assigns", () => {
    const project = serviceProject(
      `
        import type { OrdersReader } from "./dao";
        export class OrdersService {
          private readonly dao: OrdersReader;
          constructor(dao: OrdersReader) {
            this.dao = dao;
          }
          async forCustomer(id: string) {
            return this.dao.findByCustomer(id);
          }
        }
      `,
      "new OrdersDao()",
    );

    expect(
      resolvedBody(
        storeThatRead(project),
        calleeIn(project, "/service.ts", "forCustomer"),
      ),
    ).toContain('"orders:"');
  });

  it("follows a call through a field its own declaration constructs", () => {
    const project = serviceProject(
      `
        import { OrdersDao, type OrdersReader } from "./dao";
        export class OrdersService {
          private readonly dao: OrdersReader = new OrdersDao();
          async forCustomer(id: string) {
            return this.dao.findByCustomer(id);
          }
        }
      `,
      "",
    );

    expect(
      resolvedBody(
        storeThatRead(project),
        calleeIn(project, "/service.ts", "forCustomer"),
      ),
    ).toContain('"orders:"');
  });

  it("reads nothing from a parameter property a method writes again", () => {
    const project = serviceProject(
      `
        import type { OrdersReader } from "./dao";
        export class OrdersService {
          constructor(private dao: OrdersReader) {}
          swap(other: OrdersReader) {
            this.dao = other;
          }
          async forCustomer(id: string) {
            return this.dao.findByCustomer(id);
          }
        }
      `,
      "new OrdersDao()",
    );

    expect(
      resolvedBody(
        storeThatRead(project),
        calleeIn(project, "/service.ts", "forCustomer"),
      ),
    ).toBeNull();
  });

  it("reads nothing when two construction sites pass different classes", () => {
    const project = projectOf({
      "/dao.ts": READER,
      "/service.ts": `
        import type { OrdersReader } from "./dao";
        export class OrdersService {
          constructor(private readonly dao: OrdersReader) {}
          async forCustomer(id: string) {
            return this.dao.findByCustomer(id);
          }
        }
      `,
      "/entry.ts": `
        import { OrdersDao, InvoicesDao } from "./dao";
        import { OrdersService } from "./service";
        export const handler = async (id: string) => {
          const orders = new OrdersService(new OrdersDao());
          const invoices = new OrdersService(new InvoicesDao());
          return [orders.forCustomer(id), invoices.forCustomer(id)];
        };
      `,
    });

    expect(
      resolvedBody(
        storeThatRead(project),
        calleeIn(project, "/service.ts", "forCustomer"),
      ),
    ).toBeNull();
  });

  it("reads nothing when the construction site passes a value it cannot follow", () => {
    const project = serviceProject(
      `
        import type { OrdersReader } from "./dao";
        export class OrdersService {
          constructor(private readonly dao: OrdersReader) {}
          async forCustomer(id: string) {
            return this.dao.findByCustomer(id);
          }
        }
      `,
      "JSON.parse(id) as OrdersReader",
    );

    expect(
      resolvedBody(
        storeThatRead(project),
        calleeIn(project, "/service.ts", "forCustomer"),
      ),
    ).toBeNull();
  });
});

describe("a dependency a factory built", () => {
  function factoryProject(factory: string, made: string): Project {
    return projectOf({
      "/dao.ts": READER,
      "/factory.ts": factory,
      "/entry.ts": `
        import { makeDao } from "./factory";
        import { OrdersService } from "./service";
        export const handler = async (id: string) => {
          const service = new OrdersService(${made});
          return service.forCustomer(id);
        };
      `,
      "/service.ts": `
        import type { OrdersReader } from "./dao";
        export class OrdersService {
          constructor(private readonly dao: OrdersReader) {}
          async forCustomer(id: string) {
            return this.dao.findByCustomer(id);
          }
        }
      `,
    });
  }

  /**
   * The entry file goes in as the second file to walk out from, which is
   * what the closure hands in: nothing service.ts imports says where the
   * factory it was handed lives.
   */
  function daoFrom(project: Project): string | null {
    const resolved = new ResolutionStore().resolveCallable(
      calleeIn(project, "/service.ts", "forCustomer"),
      project.getSourceFileOrThrow("/entry.ts"),
    );
    return resolved === null ? null : resolved.getText().replace(/\s+/g, " ");
  }

  it("follows a call to the class a factory returns, with the return type declared", () => {
    expect(
      daoFrom(
        factoryProject(
          `
            import { OrdersDao, type OrdersReader } from "./dao";
            export function makeDao(): OrdersReader {
              return new OrdersDao();
            }
          `,
          "makeDao()",
        ),
      ),
    ).toContain('"orders:"');
  });

  it("follows the same call when the factory's return type is inferred", () => {
    expect(
      daoFrom(
        factoryProject(
          `
            import { OrdersDao } from "./dao";
            export function makeDao() {
              return new OrdersDao();
            }
          `,
          "makeDao()",
        ),
      ),
    ).toContain('"orders:"');
  });

  it("follows a call through a factory that returns a factory", () => {
    expect(
      daoFrom(
        factoryProject(
          `
            import { OrdersDao, type OrdersReader } from "./dao";
            export function makeDao(): () => OrdersReader {
              return () => new OrdersDao();
            }
          `,
          "makeDao()()",
        ),
      ),
    ).toContain('"orders:"');
  });

  it("reads nothing when the factory returns a value it cannot follow", () => {
    expect(
      daoFrom(
        factoryProject(
          `
            import type { OrdersReader } from "./dao";
            export function makeDao(): OrdersReader {
              return JSON.parse(process.env.DAO ?? "") as OrdersReader;
            }
          `,
          "makeDao()",
        ),
      ),
    ).toBeNull();
  });

  it("reads nothing when two factories return different classes", () => {
    expect(
      daoFrom(
        factoryProject(
          `
            import { InvoicesDao, OrdersDao, type OrdersReader } from "./dao";
            export function makeDao(): OrdersReader {
              return process.env.MODE === "orders"
                ? new OrdersDao()
                : new InvoicesDao();
            }
          `,
          "makeDao()",
        ),
      ),
    ).toBeNull();
  });
});
