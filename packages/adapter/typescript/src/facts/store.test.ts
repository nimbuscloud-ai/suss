// Each test lays out a small in-memory project shaped like a pattern
// seen in production code, then asks the store the one question that
// matters: which function does this export resolve to, or which
// packages does this file reach.

import { type Node, Project } from "ts-morph";
import { describe, expect, it } from "vitest";

import { ResolutionStore } from "./store.js";

function projectOf(files: Record<string, string>): Project {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: { allowJs: true },
  });
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
    // The production shape: withInstrumentation(config, fn).
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
    // The other production shape: Service.createProtectedHandler(fn).
    const project = projectOf({
      "/mod.ts": `
        class AuthService {
          static createProtectedHandler(fn: (event: unknown) => Promise<unknown>) {
            return async (event: unknown) => {
              return fn(event);
            };
          }
        }
        const inner = async (event: unknown) => "protected";
        export const handler = AuthService.createProtectedHandler(inner);
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
      { callee: "Sentry.wrapHandler", argument: 0 },
    ]);

    expect(
      resolvedBody(store, exportValue(project, "/mod.ts", "handler")),
    ).toContain("sentry wrapped");
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
    // The production shape: an internal aws package re-exports the SDK.
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
});
