/**
 * A typed effect a pack recognized says what had to be true before the
 * call ran, the same way a plain invocation effect does. Without that,
 * a write behind a feature flag reads as unconditional, and the pass
 * that decides which branch an effect belongs to has nothing to go on.
 */

import { Node, Project } from "ts-morph";
import { describe, expect, it } from "vitest";

import { storageBinding } from "@suss/behavioral-ir";

import {
  runAccessRecognizers,
  runAccessRecognizersAtModuleScope,
  runInvocationRecognizers,
} from "./invocationEffects.js";

import type { AccessRecognizer, InvocationRecognizer } from "@suss/extractor";
import type { FunctionRoot } from "../conditions.js";

const binding = storageBinding({
  recognition: "test",
  storageSystem: "test.db",
  scope: "test",
  container: "rows",
});

const insertRecognizer: InvocationRecognizer = (call) => {
  const node = call as Node;
  if (!Node.isCallExpression(node)) {
    return null;
  }
  if (node.getExpression().getText() !== "db.insert") {
    return null;
  }
  return [
    {
      type: "interaction",
      binding,
      callee: "db.insert",
      interaction: { class: "storage-access", kind: "write", fields: [] },
    },
  ];
};

const rowsAccessRecognizer: AccessRecognizer = (access) => {
  const node = access as Node;
  if (!Node.isPropertyAccessExpression(node)) {
    return null;
  }
  if (node.getText() !== "db.rows") {
    return null;
  }
  return [
    {
      type: "interaction",
      binding,
      callee: "db.rows",
      interaction: { class: "storage-access", kind: "read", fields: [] },
    },
  ];
};

function sourceOf(body: string): Project {
  const project = new Project({ useInMemoryFileSystem: true });
  project.createSourceFile("/service/save.ts", body);
  return project;
}

function functionOf(body: string): FunctionRoot {
  const project = sourceOf(body);
  const fn = project.getSourceFileOrThrow("/service/save.ts").getFunctions()[0];
  if (fn === undefined) {
    throw new Error("no function in the source");
  }
  return fn;
}

describe("preconditions on a recognized effect", () => {
  it("records the guard a recognized call runs behind", () => {
    const fn = functionOf(`
      function save(flag: boolean, db: any, row: any) {
        if (flag) {
          db.insert(row);
        }
      }
    `);
    const [recognized] = runInvocationRecognizers(fn, [insertRecognizer]);
    expect(recognized.preconditions.map((c) => c.sourceText)).toEqual(["flag"]);
    expect(recognized.preconditions[0].polarity).toBe("positive");
    if (recognized.effect.type !== "interaction") {
      throw new Error("expected an interaction effect");
    }
    expect(recognized.effect.preconditions).toHaveLength(1);
  });

  it("negates the guard for a call in the else arm", () => {
    const fn = functionOf(`
      function save(flag: boolean, db: any, row: any) {
        if (flag) {
          noop();
        } else {
          db.insert(row);
        }
      }
    `);
    const [recognized] = runInvocationRecognizers(fn, [insertRecognizer]);
    expect(recognized.preconditions[0].polarity).toBe("negative");
    if (recognized.effect.type !== "interaction") {
      throw new Error("expected an interaction effect");
    }
    expect(recognized.effect.preconditions?.[0].type).toBe("negation");
  });

  it("leaves a call nobody gated without preconditions", () => {
    const fn = functionOf(`
      function save(db: any, row: any) {
        db.insert(row);
      }
    `);
    const [recognized] = runInvocationRecognizers(fn, [insertRecognizer]);
    expect(recognized.preconditions).toEqual([]);
    if (recognized.effect.type !== "interaction") {
      throw new Error("expected an interaction effect");
    }
    expect(recognized.effect.preconditions).toBeUndefined();
  });

  it("records the guard on a recognized property access too", () => {
    const fn = functionOf(`
      function save(flag: boolean, db: any) {
        if (flag) {
          return db.rows;
        }
        return null;
      }
    `);
    const [recognized] = runAccessRecognizers(fn, [rowsAccessRecognizer]);
    expect(recognized.preconditions.map((c) => c.sourceText)).toEqual(["flag"]);
    if (recognized.effect.type !== "interaction") {
      throw new Error("expected an interaction effect");
    }
    expect(recognized.effect.preconditions).toHaveLength(1);
  });

  it("records the guard on a read the module does when it loads", () => {
    const project = sourceOf(`
      declare const flag: boolean;
      declare const db: any;
      if (flag) {
        const seed = db.rows;
      }
    `);
    const [recognized] = runAccessRecognizersAtModuleScope(
      project.getSourceFileOrThrow("/service/save.ts"),
      [rowsAccessRecognizer],
    );
    expect(recognized.preconditions.map((c) => c.sourceText)).toEqual(["flag"]);
  });
});
