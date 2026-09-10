import { describe, expect, it } from "vitest";

import { valueLeftByWrites } from "@suss/resolution";
import { createTestProject } from "@suss/test-project";

import { describeWrites, writesToBinding } from "./assignments.js";

import type { Project } from "ts-morph";

function projectOf(source: string): Project {
  const project = createTestProject();
  project.createSourceFile("/mod.ts", source);
  return project;
}

function bindingOf(project: Project, name: string) {
  return project
    .getSourceFileOrThrow("/mod.ts")
    .getVariableDeclarationOrThrow(name);
}

function settledText(project: Project, name: string): string | null {
  const { values, inOrder } = writesToBinding(bindingOf(project, name));
  const key = valueLeftByWrites(describeWrites(values), inOrder);
  return key === null ? null : (values[Number(key)]?.getText() ?? null);
}

describe("describeWrites", () => {
  it("settles on the construction a guard writes once", () => {
    const project = projectOf(`
      declare class Client {}
      let cachedClient: Client | null = null;
      if (Math.random() > 0.5) {
        cachedClient = new Client();
      }
    `);

    expect(settledText(project, "cachedClient")).toBe("new Client()");
  });

  it("settles on an object literal a guard writes into an uninitialized name", () => {
    const project = projectOf(`
      declare const parsed: Record<string, string | undefined>;
      let db: { instance: string | undefined };
      if (parsed.DB_INSTANCE) {
        db = { instance: parsed.DB_INSTANCE };
      }
    `);

    expect(settledText(project, "db")).toBe("{ instance: parsed.DB_INSTANCE }");
  });

  it("settles on nothing when two guards write different object literals", () => {
    const project = projectOf(`
      declare const flag: boolean;
      let db: { name: string };
      if (flag) {
        db = { name: "a" };
      } else {
        db = { name: "b" };
      }
    `);

    expect(settledText(project, "db")).toBe(null);
  });

  it("reads the value of a ??= write as the write's construction", () => {
    const project = projectOf(`
      declare function build(): unknown;
      let cachedClient: unknown = null;
      function useIt() {
        cachedClient ??= build();
      }
    `);

    expect(settledText(project, "cachedClient")).toBe("build()");
  });

  it("reads the value of a ||= write as the write's construction", () => {
    const project = projectOf(`
      declare function build(): unknown;
      let cachedClient: unknown = null;
      function useIt() {
        cachedClient ||= build();
      }
    `);

    expect(settledText(project, "cachedClient")).toBe("build()");
  });

  it("settles on nothing when the writes are different constructions", () => {
    const project = projectOf(`
      declare class Client {}
      declare class OtherClient {}
      let cachedClient: unknown = null;
      function useIt(alt: boolean) {
        if (alt) {
          cachedClient = new OtherClient();
        } else {
          cachedClient = new Client();
        }
      }
    `);

    expect(settledText(project, "cachedClient")).toBe(null);
  });

  it("settles on nothing when every write is a null or undefined placeholder", () => {
    const project = projectOf(`
      let cachedClient: unknown = null;
      function reset() {
        cachedClient = undefined;
      }
    `);

    expect(settledText(project, "cachedClient")).toBe(null);
  });

  it("settles on nothing when a write is neither a placeholder nor a construction", () => {
    const project = projectOf(`
      declare const fallback: unknown;
      let cachedClient: unknown = null;
      function useIt() {
        cachedClient = fallback;
      }
    `);

    expect(settledText(project, "cachedClient")).toBe(null);
  });

  it("settles on nothing when a name is written with +=", () => {
    const project = projectOf(`
      let count = 0;
      function bump() {
        count += 1;
      }
    `);

    expect(settledText(project, "count")).toBe(null);
  });
});

describe("writesToBinding", () => {
  it("still orders writes made directly in the module body", () => {
    const project = projectOf(`
      function later() { return "later"; }
      let handler = () => "first";
      handler = later;
    `);
    const { values, inOrder } = writesToBinding(bindingOf(project, "handler"));

    expect(inOrder).toBe(true);
    expect(values[values.length - 1]?.getText()).toBe("later");
  });
});
