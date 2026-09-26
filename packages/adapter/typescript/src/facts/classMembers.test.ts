import { type Node, type Project, SyntaxKind } from "ts-morph";
import { describe, expect, it } from "vitest";

import { createTestProject } from "@suss/test-project";

import { ResolutionStore } from "./store.js";

function projectOf(source: string): Project {
  const project = createTestProject();
  project.createSourceFile("/mod.ts", source);
  return project;
}

/** The value `/mod.ts` assigns to the module-level name `name`. */
function assignedTo(project: Project, name: string): Node {
  const value = project
    .getSourceFileOrThrow("/mod.ts")
    .getVariableDeclarationOrThrow(name)
    .getInitializer();
  if (value === undefined) {
    throw new Error(`${name} has no value`);
  }
  return value;
}

/** The property read in `/mod.ts` written as `text`, inside the method `method`. */
function readIn(project: Project, method: string, text: string): Node {
  const read = project
    .getSourceFileOrThrow("/mod.ts")
    .getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)
    .find(
      (access) =>
        access.getText() === text &&
        access
          .getFirstAncestorByKind(SyntaxKind.MethodDeclaration)
          ?.getName() === method,
    );
  if (read === undefined) {
    throw new Error(`no ${text} in ${method}`);
  }
  return read;
}

function resolvedBody(value: Node): string | null {
  const resolved = new ResolutionStore().resolveCallable(value);
  return resolved === null ? null : resolved.getText().replace(/\s+/g, " ");
}

const STATIC_LIST = 'static list() { return "static"; }';
const INSTANCE_LIST = 'list() { return "instance"; }';

/** A class with a static and an instance method of one name. */
const ORDERS = `
  export class Orders {
    ${STATIC_LIST}
    ${INSTANCE_LIST}
    static pick() { return this.list; }
    own() { return this.list; }
  }
`;

describe("a static and an instance method of one name", () => {
  it("resolves a read off the class to the static", () => {
    const project = projectOf(`${ORDERS}
      export const handler = Orders.list;
    `);
    expect(resolvedBody(assignedTo(project, "handler"))).toBe(STATIC_LIST);
  });

  it("resolves a read off an instance to the instance method", () => {
    const project = projectOf(`${ORDERS}
      export const handler = new Orders().list;
    `);
    expect(resolvedBody(assignedTo(project, "handler"))).toBe(INSTANCE_LIST);
  });

  it("resolves `this` in a static method to the class, and in an instance method to an instance", () => {
    const project = projectOf(ORDERS);
    expect(resolvedBody(readIn(project, "pick", "this.list"))).toBe(
      STATIC_LIST,
    );
    expect(resolvedBody(readIn(project, "own", "this.list"))).toBe(
      INSTANCE_LIST,
    );
  });

  it("resolves a subclass's read off its own name to the static it inherits", () => {
    const project = projectOf(`${ORDERS}
      export class RushOrders extends Orders {}
      export const handler = RushOrders.list;
    `);
    expect(resolvedBody(assignedTo(project, "handler"))).toBe(STATIC_LIST);
  });

  it("gives a handler registered off the class the static", () => {
    const project = projectOf(`${ORDERS}
      export const handler = Orders.list;
    `);
    const value = assignedTo(project, "handler");
    const resolved = new ResolutionStore()
      .resolveCalledFunctions([value])
      .get(value);
    expect(resolved?.getText().replace(/\s+/g, " ")).toBe(STATIC_LIST);
  });
});
