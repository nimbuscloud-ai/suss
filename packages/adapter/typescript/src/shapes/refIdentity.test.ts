// A ref gives the name of a type suss chose not to expand. Two questions follow
// from that: does the name identify the type, and does the same type
// always get the same ref?
//
// The fixtures are recursive on purpose. A ref is what a walk leaves
// behind when it reaches a type it is already inside, so a type that
// refers to itself is the shortest way to reach that branch.

import { describe, expect, it } from "vitest";

import { createTestProject } from "@suss/test-project";

import { shapeFromNodeType } from "./typeShapes.js";

import type { TypeShape } from "@suss/behavioral-ir";
import type { Node, Project } from "ts-morph";

/** The initializer of `const <name> = ...`, as the walk would reach it. */
function valueNamed(project: Project, name: string): Node {
  for (const file of project.getSourceFiles()) {
    const declaration = file.getVariableDeclaration(name);
    if (declaration !== undefined) {
      const initializer = declaration.getInitializer();
      if (initializer !== undefined) {
        return initializer;
      }
    }
  }
  throw new Error(`no value named ${name}`);
}

/** The ref sitting at `<value>.child`. */
function childRefOf(
  project: Project,
  name: string,
): { name: string; from?: string } {
  const shape = shapeFromNodeType(valueNamed(project, name));
  if (shape === null || shape.type !== "record") {
    throw new Error(`expected a record, got ${JSON.stringify(shape)}`);
  }
  const child: TypeShape | undefined = shape.properties.child;
  if (child === undefined || child.type !== "ref") {
    throw new Error(`expected a ref at .child, got ${JSON.stringify(child)}`);
  }
  return child.from === undefined
    ? { name: child.name }
    : { name: child.name, from: child.from };
}

const treeHolding = (field: string): string => `
export interface Tree {
  ${field}: string;
  child: Tree;
}
`;

describe("a ref to a project type", () => {
  it("says which file declared it", () => {
    const project = createTestProject();
    project.createSourceFile("src/models.ts", treeHolding("label"));
    project.createSourceFile(
      "src/use.ts",
      "import type { Tree } from './models.js';\ndeclare const t: Tree;\nexport const root = t;\n",
    );

    const ref = childRefOf(project, "root");

    expect(ref.name).toBe("Tree");
    expect(ref.from).toContain("src/models.ts");
  });

  it("tells two types with the same name apart", () => {
    const project = createTestProject();
    project.createSourceFile("src/billing.ts", treeHolding("plan"));
    project.createSourceFile("src/auth.ts", treeHolding("token"));
    project.createSourceFile(
      "src/use.ts",
      [
        "import type { Tree as Billing } from './billing.js';",
        "import type { Tree as Auth } from './auth.js';",
        "declare const b: Billing;",
        "declare const a: Auth;",
        "export const payer = b;",
        "export const caller = a;",
      ].join("\n"),
    );

    const payer = childRefOf(project, "payer");
    const caller = childRefOf(project, "caller");

    expect(payer.name).toBe(caller.name);
    expect(payer.from).not.toBe(caller.from);
  });
});

describe("the same type reached from two places", () => {
  it("comes out the same however the walk got there", () => {
    const project = createTestProject();
    project.createSourceFile("src/models.ts", treeHolding("label"));
    project.createSourceFile(
      "src/near.ts",
      "import type { Tree } from './models.js';\ndeclare const t: Tree;\nexport const nearby = t;\n",
    );
    project.createSourceFile(
      "src/far/deep/away.ts",
      "import type { Tree } from '../../models.js';\ndeclare const t: Tree;\nexport const distant = t;\n",
    );

    expect(childRefOf(project, "distant")).toEqual(
      childRefOf(project, "nearby"),
    );
  });
});
