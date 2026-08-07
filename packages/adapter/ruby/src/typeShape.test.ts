import { describe, expect, it } from "vitest";

import { bodyStatements } from "./ast.js";
import { parseRuby } from "./parser.js";
import { typeShapeFromNode } from "./typeShape.js";

import type { RbNode } from "./parser.js";

const NO_KNOWN_CLASSES: ReadonlySet<string> = new Set();

async function typeExprNode(source: string): Promise<RbNode> {
  const tree = await parseRuby(source);
  const node = bodyStatements(tree.rootNode)[0];
  if (node === undefined) {
    throw new Error("expected a statement");
  }
  return node;
}

describe("typeShapeFromNode: scalars", () => {
  it.each([
    ["ID", { type: "text" }],
    ["String", { type: "text" }],
    ["Int", { type: "number" }],
    ["Float", { type: "number" }],
    ["Boolean", { type: "boolean" }],
    ["Integer", { type: "number" }],
  ] as const)("reads bare %s as %o", async (name, expected) => {
    const node = await typeExprNode(`${name}\n`);
    expect(typeShapeFromNode(node, [], NO_KNOWN_CLASSES)).toEqual(expected);
  });

  it("resolves a scalar written under its module path", async () => {
    const node = await typeExprNode("GraphQL::Types::ID\n");
    expect(typeShapeFromNode(node, [], NO_KNOWN_CLASSES)).toEqual({
      type: "text",
    });
  });

  it("does not qualify a bare scalar against enclosing nesting when nothing shadows it", async () => {
    // A bare `ID` reaches a field call by inheritance from graphql-ruby's
    // base classes, not by the writer's own module nesting, so nesting
    // must not shadow the scalar lookup with a guessed project type
    // when the file defines no class of that name.
    const node = await typeExprNode("ID\n");
    expect(
      typeShapeFromNode(node, ["Types::CampaignType"], NO_KNOWN_CLASSES),
    ).toEqual({ type: "text" });
  });

  it("resolves to the project's own class when it shadows a scalar name at some level of nesting", async () => {
    // A project defining `Types::ID` (unusual, but legal Ruby) shadows
    // the builtin the same way Ruby's own constant lookup would find
    // the nesting-reachable class before ever falling through to a
    // base-class-inherited scalar. Nesting is checked before the
    // scalar table specifically so this doesn't silently read as the
    // builtin `ID` scalar.
    const node = await typeExprNode("ID\n");
    const knownClasses = new Set(["Types::ID", "Types::CampaignType"]);
    const shape = typeShapeFromNode(
      node,
      ["Types::CampaignType", "Types"],
      knownClasses,
    );
    expect(shape).toEqual({ type: "ref", name: "ID" });
  });
});

describe("typeShapeFromNode: refs", () => {
  it("reads a compound project type as a ref by its GraphQL type name", async () => {
    const node = await typeExprNode("Types::CampaignType\n");
    expect(typeShapeFromNode(node, [], NO_KNOWN_CLASSES)).toEqual({
      type: "ref",
      name: "Campaign",
    });
  });

  it("qualifies a bare project type against the innermost nesting level", async () => {
    const node = await typeExprNode("CampaignType\n");
    expect(typeShapeFromNode(node, ["Types"], NO_KNOWN_CLASSES)).toEqual({
      type: "ref",
      name: "Campaign",
    });
  });
});

describe("typeShapeFromNode: lists", () => {
  it("wraps a one-element array literal as an array shape", async () => {
    const node = await typeExprNode("[String]\n");
    expect(typeShapeFromNode(node, [], NO_KNOWN_CLASSES)).toEqual({
      type: "array",
      items: { type: "text" },
    });
  });

  it("wraps a list of a project type the same way", async () => {
    const node = await typeExprNode("[Types::CampaignType]\n");
    expect(typeShapeFromNode(node, [], NO_KNOWN_CLASSES)).toEqual({
      type: "array",
      items: { type: "ref", name: "Campaign" },
    });
  });
});

describe("typeShapeFromNode: abstains", () => {
  it("is null for a method call", async () => {
    const node = await typeExprNode("status_label_for(:organizer)\n");
    expect(typeShapeFromNode(node, [], NO_KNOWN_CLASSES)).toBeNull();
  });

  it("is null for a lambda", async () => {
    const node = await typeExprNode("-> { Types::CampaignType }\n");
    expect(typeShapeFromNode(node, [], NO_KNOWN_CLASSES)).toBeNull();
  });

  it("is null for an array wrapping a non-literal expression", async () => {
    const node = await typeExprNode("[status_label_for(:organizer)]\n");
    expect(typeShapeFromNode(node, [], NO_KNOWN_CLASSES)).toBeNull();
  });
});
