// Each test lays out a small in-memory project shaped like a pattern
// seen in production code, then asks the store the one question that
// matters: which function does this export resolve to, or which
// packages does this file reach.

import { type Node, Project, SyntaxKind } from "ts-morph";
import { describe, expect, it } from "vitest";

import { ResolutionStore } from "./store.js";

function projectOf(files: Record<string, string>): Project {
  const project = new Project({
    useInMemoryFileSystem: true,
    // moduleResolution node so a fixture can put a package under
    // node_modules and have imports of it actually resolve there.
    compilerOptions: { allowJs: true, moduleResolution: 100 },
  });
  // The compiler enumerates the @types root when resolving a package
  // that ships its declarations separately, and an in-memory directory
  // only exists once something makes it.
  project.getFileSystem().mkdirSync("/node_modules/@types");
  for (const [path, contents] of Object.entries(files)) {
    project.createSourceFile(path, contents);
  }
  return project;
}

/** The exported value node for `name` in `file`. */
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
    // The handler is not the first argument, so the rule has to find which
    // parameter the returned function calls.
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
    // The wrapper is a static method rather than a free function, so the
    // callee is a property access and not an identifier.
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

  it("ignores a local object spelled like a declared wrapper", () => {
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

    // Nothing imported the library, so the declaration does not apply.
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
      // The package has to be on disk for this to mean anything: the
      // barrel forwards the symbol, and the only thing that can say
      // where it came from is where it turns out to live.
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

    // The barrel forwards the library too, but this wrapHandler is the
    // local one, and the local one is not transparent.
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

    // The type comes from the library and the function does not.
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

    // The declaration lives in @types/sentry-js, and a pack names the
    // package people import.
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

  it("resolves a second export in a file it already extracted", () => {
    const project = projectOf({
      "/impl.ts": `export const realHandler = async () => "from impl";`,
      "/mod.ts": `
        import { realHandler } from "./impl";
        export const local = async () => "local";
        export const imported = realHandler;
      `,
    });
    const store = new ResolutionStore();

    // The first query extracts /mod.ts and answers without leaving it.
    // The second has to walk into /impl.ts, which it can only do if the
    // frontier comes from the module graph rather than from what is
    // left to extract.
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

    // Both arguments qualify, so the rules cannot say which function
    // this is. Picking one would depend on the order facts arrived in.
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

describe("a query rooted at a wrapped value", () => {
  /** The argument at `position` of the first call to `callee` in `file`. */
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

describe("importsTransitively", () => {
  it("sees a direct import", () => {
    const project = projectOf({
      "/mod.ts": `import { SendMessageCommand } from "@aws-sdk/client-sqs";`,
    });
    const store = new ResolutionStore();

    expect(
      store.importsTransitively(project.getSourceFileOrThrow("/mod.ts"), [
        "@aws-sdk/client-sqs",
      ]),
    ).toBe(true);
  });

  it("sees a package through a project-local barrel", () => {
    // A shared package re-exports the SDK, so the importing file never
    // names the SDK itself and the gate has to follow the re-export.
    const project = projectOf({
      "/aws/sqs.ts": `export { SendMessageCommand } from "@aws-sdk/client-sqs";`,
      "/service.ts": `
        import { SendMessageCommand } from "./aws/sqs";
        export const send = () => new SendMessageCommand({});
      `,
    });
    const store = new ResolutionStore();

    expect(
      store.importsTransitively(project.getSourceFileOrThrow("/service.ts"), [
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
      store.importsTransitively(project.getSourceFileOrThrow("/service.ts"), [
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
      store.importsTransitively(project.getSourceFileOrThrow("/mod.ts"), [
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
      store.importsTransitively(project.getSourceFileOrThrow("/mod.ts"), [
        "@aws-sdk/client-sqs",
      ]),
    ).toBe(false);
  });

  it("answers the same file twice from the cache", () => {
    const project = projectOf({
      "/aws/sqs.ts": `export { SendMessageCommand } from "@aws-sdk/client-sqs";`,
      "/service.ts": `import { SendMessageCommand } from "./aws/sqs";`,
    });
    const store = new ResolutionStore();
    const file = project.getSourceFileOrThrow("/service.ts");

    expect(store.importsTransitively(file, ["@aws-sdk/client-sqs"])).toBe(true);
    expect(store.importsTransitively(file, ["@aws-sdk/client-sqs"])).toBe(true);
  });

  it("reuses a yes it learned about a file deeper in the graph", () => {
    const project = projectOf({
      "/aws/sqs.ts": `export { SendMessageCommand } from "@aws-sdk/client-sqs";`,
      "/mid.ts": `export { SendMessageCommand } from "./aws/sqs";`,
      "/service.ts": `import { SendMessageCommand } from "./mid";`,
    });
    const store = new ResolutionStore();
    const gates = ["@aws-sdk/client-sqs"];

    // Walking from /mid.ts records the answer for /mid.ts itself, which
    // the walk from /service.ts then hits instead of walking further.
    expect(
      store.importsTransitively(project.getSourceFileOrThrow("/mid.ts"), gates),
    ).toBe(true);
    expect(
      store.importsTransitively(
        project.getSourceFileOrThrow("/service.ts"),
        gates,
      ),
    ).toBe(true);
  });

  it("caches a no for every file the walk covered", () => {
    const project = projectOf({
      "/leaf.ts": "export const x = 1;",
      "/mid.ts": `export { x } from "./leaf";`,
      "/service.ts": `import { x } from "./mid";`,
    });
    const store = new ResolutionStore();
    const gates = ["@aws-sdk/client-sqs"];

    expect(
      store.importsTransitively(
        project.getSourceFileOrThrow("/service.ts"),
        gates,
      ),
    ).toBe(false);
    expect(
      store.importsTransitively(project.getSourceFileOrThrow("/mid.ts"), gates),
    ).toBe(false);
  });

  it("walks a cycle without looping", () => {
    const project = projectOf({
      "/a.ts": `import { b } from "./b"; export const a = b;`,
      "/b.ts": `import { a } from "./a"; export const b = a;`,
    });
    const store = new ResolutionStore();

    expect(
      store.importsTransitively(project.getSourceFileOrThrow("/a.ts"), [
        "@aws-sdk/client-sqs",
      ]),
    ).toBe(false);
  });
});

describe("resolveWrittenValue", () => {
  /** The identifier `name` where it is passed to a call in `file`. */
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

    // The ternary is what the name is written as, and it is not a
    // document, so a caller looking for one comes away with nothing.
    const written = store.resolveWrittenValue(
      usageOf(project, "/mod.ts", "DOC"),
    );
    expect(written?.getKindName()).toBe("ConditionalExpression");
  });
});
