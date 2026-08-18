// A pack asks what a table, a bucket or a cache key is called. Each
// test is one way production code builds one.

import { describe, expect, it } from "vitest";

import { createTestProject } from "@suss/test-project";

import { ResolutionStore } from "../facts/store.js";
import { readName } from "./readName.js";

import type { Node } from "ts-morph";

/** The name of the expression a fixture assigns to `subject`. */
function nameOf(source: string): string | null {
  const project = createTestProject();
  const file = project.createSourceFile("/repo.ts", source);
  const store = new ResolutionStore();
  const declaration = file.getVariableDeclarationOrThrow("subject");
  const initializer = declaration.getInitializerOrThrow();
  return readName(initializer, {
    resolve: (value: Node) => store.resolveWrittenValue(value),
  });
}

describe("a name written where it is used", () => {
  it("reads a string literal", () => {
    expect(nameOf(`export const subject = "orders";`)).toBe("orders");
  });

  it("reads a template as fixed text and holes", () => {
    expect(
      nameOf(`
        declare const stage: string;
        export const subject = \`\${stage}-orders-v1\`;
      `),
    ).toBe("{stage}-orders-v1");
  });

  it("names a hole after the field it came from", () => {
    expect(
      nameOf(`
        declare const config: { stage: string };
        export const subject = \`\${config.stage}-orders\`;
      `),
    ).toBe("{stage}-orders");
  });

  it("reads what a lookup falls back to", () => {
    expect(
      nameOf(`export const subject = process.env.TABLE ?? "orders-prod";`),
    ).toBe("orders-prod");
  });

  it("joins the two sides of a concatenation", () => {
    expect(
      nameOf(`
        declare const stage: string;
        export const subject = stage + "-orders";
      `),
    ).toBe("{stage}-orders");
  });

  it("says nothing about a name that comes from a parameter", () => {
    expect(
      nameOf(`
        declare const table: string;
        export const subject = table;
      `),
    ).toBeNull();
  });
});

describe("a name built by a helper", () => {
  it("follows a call into a function whose body is one return", () => {
    expect(
      nameOf(`
        function tableName(stage: string) {
          return \`\${stage}-orders\`;
        }
        declare const stage: string;
        export const subject = tableName(stage);
      `),
    ).toBe("{stage}-orders");
  });

  it("puts the caller's argument in the hole, not the parameter", () => {
    expect(
      nameOf(`
        const keyFor = (id: string) => \`session:\${id}\`;
        declare const userId: string;
        export const subject = keyFor(userId);
      `),
    ).toBe("session:{userId}");
  });

  it("reads a literal the caller passed", () => {
    expect(
      nameOf(`
        function tableName(name: string) {
          return \`prod-\${name}\`;
        }
        export const subject = tableName("orders");
      `),
    ).toBe("prod-orders");
  });

  it("reads a key builder that joins its arguments", () => {
    expect(
      nameOf(`
        function buildKey(...parts: (string | number)[]): string {
          return parts.map(String).join(":");
        }
        declare const communityId: string;
        declare const userId: string;
        export const subject = buildKey("similar_users", communityId, userId);
      `),
    ).toBe("similar_users:{communityId}:{userId}");
  });

  it("follows a helper that calls a helper", () => {
    expect(
      nameOf(`
        function buildKey(...parts: string[]) {
          return parts.join(":");
        }
        function cacheKey(userId: string) {
          return buildKey("similar_users", userId);
        }
        declare const id: string;
        export const subject = cacheKey(id);
      `),
    ).toBe("similar_users:{id}");
  });

  it("stops at a helper whose body does more than return", () => {
    expect(
      nameOf(`
        function tableName(stage: string) {
          const prefix = stage.toUpperCase();
          return \`\${prefix}-orders\`;
        }
        declare const stage: string;
        export const subject = tableName(stage);
      `),
    ).toBeNull();
  });

  it("stops at a helper that answers differently per branch", () => {
    expect(
      nameOf(`
        function tableName(stage: string) {
          if (stage === "prod") {
            return "orders-prod";
          }
          return "orders-dev";
        }
        declare const stage: string;
        export const subject = tableName(stage);
      `),
    ).toBeNull();
  });

  it("says nothing about a helper it cannot see the body of", () => {
    expect(
      nameOf(`
        declare function tableName(stage: string): string;
        declare const stage: string;
        export const subject = tableName(stage);
      `),
    ).toBeNull();
  });

  it("stops rather than looping on a helper that calls itself", () => {
    expect(
      nameOf(`
        function keyFor(id: string): string {
          return keyFor(id);
        }
        declare const id: string;
        export const subject = keyFor(id);
      `),
    ).toBeNull();
  });
});

describe("a name the code says is somewhere else", () => {
  function referenceOf(source: string): string | null {
    const project = createTestProject();
    const file = project.createSourceFile("/repo.ts", source);
    const store = new ResolutionStore();
    const initializer = file
      .getVariableDeclarationOrThrow("subject")
      .getInitializerOrThrow();
    return readName(initializer, {
      resolve: (value: Node) => store.resolveWrittenValue(value),
      unsettled: "reference",
    });
  }

  /** The same read, on an expression inside a function that takes arguments. */
  function referenceInWrapper(source: string): string | null {
    const project = createTestProject();
    const file = project.createSourceFile("/wrapper.ts", source);
    const store = new ResolutionStore();
    const initializer = file
      .getFunctionOrThrow("wrapper")
      .getVariableDeclarationOrThrow("subject")
      .getInitializerOrThrow();
    return readName(initializer, {
      resolve: (value: Node) => store.resolveWrittenValue(value),
      unsettled: "reference",
    });
  }

  it("states the whole path from the parameter a caller fills in", () => {
    expect(
      referenceInWrapper(`
        export function wrapper(location: { bucket: string }) {
          const subject = location.bucket;
          return subject;
        }
      `),
    ).toBe("{location.bucket}");
  });

  it("states every field on the way in, however deep", () => {
    expect(
      referenceInWrapper(`
        export function wrapper(input: { location: { bucket: string } }) {
          const subject = input.location.bucket;
          return subject;
        }
      `),
    ).toBe("{input.location.bucket}");
  });

  it("states a parameter that is the name itself", () => {
    expect(
      referenceInWrapper(`
        export function wrapper(bucket: string) {
          const subject = bucket;
          return subject;
        }
      `),
    ).toBe("{bucket}");
  });

  it("says which variable a name nobody passes comes from", () => {
    expect(
      referenceOf(`
        declare const env: { ORDERS_TABLE: string };
        export const subject = env.ORDERS_TABLE;
      `),
    ).toBe("{ORDERS_TABLE}");
  });

  it("says which variable the name comes from", () => {
    expect(
      referenceOf(`
        declare const bucketName: string;
        export const subject = bucketName;
      `),
    ).toBe("{bucketName}");
  });

  it("still reads a name the source does state", () => {
    expect(referenceOf(`export const subject = "orders";`)).toBe("orders");
  });
});

describe("a reference with nothing to point at", () => {
  it("says nothing, since a reference has to say what to ask about", () => {
    const project = createTestProject();
    const file = project.createSourceFile(
      "/repo.ts",
      `
        declare const config: Record<string, string>;
        declare const which: string;
        export const subject = config[which];
      `,
    );
    const initializer = file
      .getVariableDeclarationOrThrow("subject")
      .getInitializerOrThrow();

    expect(readName(initializer, { unsettled: "reference" })).toBeNull();
  });
});
