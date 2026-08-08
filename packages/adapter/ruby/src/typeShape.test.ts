import { describe, expect, it } from "vitest";

import { graphqlObjectFieldsPattern } from "./__fixtures__/graphqlRubyPattern.js";
import { bodyStatements } from "./ast.js";
import { parseRuby } from "./parser.js";
import { typeShapeFromNode } from "./typeShape.js";

import type { RbNode } from "./parser.js";
import type { TypeReadContext } from "./typeShape.js";

/** graphql-ruby's scalars and naming conventions, supplied the way a pack would, over the given scope. */
function contextOf(
  nesting: readonly string[] = [],
  knownClasses: ReadonlySet<string> = new Set(),
): TypeReadContext {
  const pattern = graphqlObjectFieldsPattern();
  return {
    nesting,
    knownClasses,
    scalars: pattern.scalars,
    scalarNamePrefixes: pattern.scalarNamePrefixes,
    typeNameConvention: pattern.typeNameConvention,
  };
}

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
    expect(typeShapeFromNode(node, contextOf())).toEqual(expected);
  });

  it("resolves a scalar written under its module path", async () => {
    const node = await typeExprNode("GraphQL::Types::ID\n");
    expect(typeShapeFromNode(node, contextOf())).toEqual({
      type: "text",
    });
  });

  it("does not qualify a bare scalar against enclosing nesting when nothing shadows it", async () => {
    const node = await typeExprNode("ID\n");
    expect(typeShapeFromNode(node, contextOf(["Types::CampaignType"]))).toEqual(
      { type: "text" },
    );
  });

  it("resolves to the project's own class when it shadows a scalar name at some level of nesting", async () => {
    const node = await typeExprNode("ID\n");
    const knownClasses = new Set(["Types::ID", "Types::CampaignType"]);
    const shape = typeShapeFromNode(
      node,
      contextOf(["Types::CampaignType", "Types"], knownClasses),
    );
    expect(shape).toEqual({ type: "ref", name: "ID" });
  });
});

describe("typeShapeFromNode: refs", () => {
  it("reads a compound project type as a ref by its GraphQL type name", async () => {
    const node = await typeExprNode("Types::CampaignType\n");
    expect(typeShapeFromNode(node, contextOf())).toEqual({
      type: "ref",
      name: "Campaign",
    });
  });

  it("qualifies a bare project type against the innermost nesting level", async () => {
    const node = await typeExprNode("CampaignType\n");
    expect(typeShapeFromNode(node, contextOf(["Types"]))).toEqual({
      type: "ref",
      name: "Campaign",
    });
  });
});

describe("typeShapeFromNode: lists", () => {
  it("wraps a one-element array literal as an array shape", async () => {
    const node = await typeExprNode("[String]\n");
    expect(typeShapeFromNode(node, contextOf())).toEqual({
      type: "array",
      items: { type: "text" },
    });
  });

  it("wraps a list of a project type the same way", async () => {
    const node = await typeExprNode("[Types::CampaignType]\n");
    expect(typeShapeFromNode(node, contextOf())).toEqual({
      type: "array",
      items: { type: "ref", name: "Campaign" },
    });
  });
});

describe("typeShapeFromNode: abstains", () => {
  it("is null for a method call", async () => {
    const node = await typeExprNode("status_label_for(:organizer)\n");
    expect(typeShapeFromNode(node, contextOf())).toBeNull();
  });

  it("is null for a lambda", async () => {
    const node = await typeExprNode("-> { Types::CampaignType }\n");
    expect(typeShapeFromNode(node, contextOf())).toBeNull();
  });

  it("is null for an array wrapping a non-literal expression", async () => {
    const node = await typeExprNode("[status_label_for(:organizer)]\n");
    expect(typeShapeFromNode(node, contextOf())).toBeNull();
  });
});
