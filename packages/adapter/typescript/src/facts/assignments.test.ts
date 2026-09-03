import { describe, expect, it } from "vitest";

import { createTestProject } from "@suss/test-project";

import {
  sameConstructionAcrossWrites,
  writesToBinding,
} from "./assignments.js";

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

describe("sameConstructionAcrossWrites", () => {
  it("returns the construction when a guard writes it once", () => {
    const project = projectOf(`
      declare class Client {}
      let cachedClient: Client | null = null;
      if (Math.random() > 0.5) {
        cachedClient = new Client();
      }
    `);
    const { values } = writesToBinding(bindingOf(project, "cachedClient"));

    expect(sameConstructionAcrossWrites(values)?.getText()).toBe(
      "new Client()",
    );
  });

  it("reads the value of a ??= write as the write's construction", () => {
    const project = projectOf(`
      declare function build(): unknown;
      let cachedClient: unknown = null;
      function useIt() {
        cachedClient ??= build();
      }
    `);
    const { values } = writesToBinding(bindingOf(project, "cachedClient"));

    expect(sameConstructionAcrossWrites(values)?.getText()).toBe("build()");
  });

  it("reads the value of a ||= write as the write's construction", () => {
    const project = projectOf(`
      declare function build(): unknown;
      let cachedClient: unknown = null;
      function useIt() {
        cachedClient ||= build();
      }
    `);
    const { values } = writesToBinding(bindingOf(project, "cachedClient"));

    expect(sameConstructionAcrossWrites(values)?.getText()).toBe("build()");
  });

  it("returns null when the writes are different constructions", () => {
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
    const { values } = writesToBinding(bindingOf(project, "cachedClient"));

    expect(sameConstructionAcrossWrites(values)).toBe(null);
  });

  it("returns null when every write is a null or undefined placeholder", () => {
    const project = projectOf(`
      let cachedClient: unknown = null;
      function reset() {
        cachedClient = undefined;
      }
    `);
    const { values } = writesToBinding(bindingOf(project, "cachedClient"));

    expect(sameConstructionAcrossWrites(values)).toBe(null);
  });

  it("returns null when a write is neither a placeholder nor a construction", () => {
    const project = projectOf(`
      declare const fallback: unknown;
      let cachedClient: unknown = null;
      function useIt() {
        cachedClient = fallback;
      }
    `);
    const { values } = writesToBinding(bindingOf(project, "cachedClient"));

    expect(sameConstructionAcrossWrites(values)).toBe(null);
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
