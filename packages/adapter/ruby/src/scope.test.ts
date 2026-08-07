import { describe, expect, it } from "vitest";

import { field } from "./ast.js";
import { parseRuby } from "./parser.js";
import {
  graphqlTypeNameFromQualified,
  qualifyConstantRef,
  shadowingClassFor,
  walkClasses,
} from "./scope.js";

import type { RbNode } from "./parser.js";
import type { ClassInfo } from "./scope.js";

function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) {
    throw new Error("expected a value, got null/undefined");
  }
  return value;
}

async function classesIn(source: string): Promise<ClassInfo[]> {
  const tree = await parseRuby(source);
  const found: ClassInfo[] = [];
  walkClasses(tree.rootNode, (info) => found.push(info));
  return found;
}

/** The first top-level expression statement's node, for tests exercising a bare expression rather than a full class/module declaration. */
async function firstExpression(source: string): Promise<RbNode> {
  const tree = await parseRuby(source);
  return must(tree.rootNode.namedChild(0));
}

describe("walkClasses: qualified names", () => {
  it("reads a compound class name as an absolute path", async () => {
    const [info] = await classesIn(
      "class Types::CampaignType < Types::BaseObject\nend\n",
    );
    expect(info?.qualifiedName).toBe("Types::CampaignType");
    expect(info?.superclassQualifiedName).toBe("Types::BaseObject");
  });

  it("qualifies a bare class name against its enclosing module", async () => {
    const [info] = await classesIn(
      "module Types\n  class QueryType < Types::BaseObject\n  end\nend\n",
    );
    expect(info?.qualifiedName).toBe("Types::QueryType");
  });

  it("qualifies a bare superclass against the enclosing scope it's written in, not the class's own name", async () => {
    const [info] = await classesIn(
      "module Types\n  class CampaignType < BaseObject\n  end\nend\n",
    );
    expect(info?.superclassQualifiedName).toBe("Types::BaseObject");
  });

  it("records null for a class with no superclass", async () => {
    const [info] = await classesIn("class Types::BaseObject\nend\n");
    expect(info?.superclassQualifiedName).toBeNull();
  });

  it("walks a class nested inside another class's body", async () => {
    const infos = await classesIn("class Outer\n  class Inner\n  end\nend\n");
    expect(infos.map((i) => i.qualifiedName)).toEqual([
      "Outer",
      "Outer::Inner",
    ]);
  });

  it("finds every class across sibling module/class statements", async () => {
    const infos = await classesIn(
      "class Types::CampaignType < Types::BaseObject\nend\nclass Types::OrganizerType < Types::BaseObject\nend\n",
    );
    expect(infos.map((i) => i.qualifiedName)).toEqual([
      "Types::CampaignType",
      "Types::OrganizerType",
    ]);
  });
});

describe("walkClasses: bodyNesting (Module.nesting)", () => {
  it("prepends a bare name onto the chain it's nested inside", async () => {
    const [info] = await classesIn(
      "module Types\n  class CampaignType < Types::BaseObject\n  end\nend\n",
    );
    expect(info?.bodyNesting).toEqual(["Types::CampaignType", "Types"]);
  });

  it("keeps the wrapping module on the chain even when the class's own name is compound", async () => {
    const [info] = await classesIn(
      "module Foo\n  class Types::CampaignType < Types::BaseObject\n  end\nend\n",
    );
    // Module.nesting tracks lexical class/module keyword nesting, not
    // the shape of the name used to open this one: "Foo" stays
    // reachable through nesting inside this body exactly the way it
    // would for a bare-named class, even though CampaignType's own
    // qualified name is the compound path as written, not
    // "Foo::Types::CampaignType".
    expect(info?.bodyNesting).toEqual(["Types::CampaignType", "Foo"]);
  });

  it("prepends each level for multiple nested bare blocks", async () => {
    const [info] = await classesIn(
      "module Foo\n  module Bar\n    class Baz\n    end\n  end\nend\n",
    );
    expect(info?.bodyNesting).toEqual(["Foo::Bar::Baz", "Foo::Bar", "Foo"]);
  });
});

describe("qualifyConstantRef", () => {
  it("returns a scope_resolution node's own text, ignoring nesting", async () => {
    const node = await firstExpression("Types::CampaignType\n");
    expect(qualifyConstantRef(node, ["SomeOther::Scope"])).toBe(
      "Types::CampaignType",
    );
  });

  it("prefixes a bare constant with the innermost nesting level", async () => {
    const node = await firstExpression("BaseObject\n");
    expect(qualifyConstantRef(node, ["Types::CampaignType", "Types"])).toBe(
      "Types::CampaignType::BaseObject",
    );
  });

  it("leaves a bare constant unqualified at the top level", async () => {
    const node = await firstExpression("BaseObject\n");
    expect(qualifyConstantRef(node, [])).toBe("BaseObject");
  });

  it("is null for anything that isn't a constant path", async () => {
    const node = await firstExpression("status_label_for(:organizer)\n");
    expect(qualifyConstantRef(node, [])).toBeNull();
  });
});

describe("shadowingClassFor", () => {
  it("finds a project class shadowing a name at an outer nesting level", async () => {
    // "String" sits at "Types", not inside "Types::CampaignType" (the
    // innermost level), so a single-level qualification would miss it;
    // the search has to walk the whole chain.
    const node = await firstExpression("String\n");
    const knownClasses = new Set(["Types::String", "Types::CampaignType"]);
    expect(
      shadowingClassFor(node, ["Types::CampaignType", "Types"], knownClasses),
    ).toBe("Types::String");
  });

  it("is null when no level of nesting names a known class", async () => {
    const node = await firstExpression("String\n");
    const knownClasses = new Set(["Types::CampaignType"]);
    expect(
      shadowingClassFor(node, ["Types::CampaignType", "Types"], knownClasses),
    ).toBeNull();
  });

  it("matches a known top-level class with no nesting prefix", async () => {
    const node = await firstExpression("Widget\n");
    expect(shadowingClassFor(node, [], new Set(["Widget"]))).toBe("Widget");
  });

  it("never shadows a compound path: it's already absolute", async () => {
    const node = await firstExpression("Types::String\n");
    const knownClasses = new Set(["Types::CampaignType::Types::String"]);
    expect(
      shadowingClassFor(node, ["Types::CampaignType"], knownClasses),
    ).toBeNull();
  });
});

describe("graphqlTypeNameFromQualified: stripTypeSuffix", () => {
  it("strips a trailing Type from the class's own short name", () => {
    expect(
      graphqlTypeNameFromQualified("Types::CampaignType", "stripTypeSuffix"),
    ).toBe("Campaign");
    expect(
      graphqlTypeNameFromQualified("Types::QueryType", "stripTypeSuffix"),
    ).toBe("Query");
    expect(
      graphqlTypeNameFromQualified("Types::MutationType", "stripTypeSuffix"),
    ).toBe("Mutation");
  });

  it("leaves a short name with no trailing Type unchanged", () => {
    expect(
      graphqlTypeNameFromQualified(
        "Mutations::CampaignUpdate",
        "stripTypeSuffix",
      ),
    ).toBe("CampaignUpdate");
  });
});

// Exercises the `field` helper against a `superclass` wrapper node,
// which scope.ts unwraps with `namedChild(0)` rather than a field name
// (the wrapper node itself carries no fields per the grammar).
describe("superclass wrapper shape", () => {
  it("wraps exactly the expression after the '<'", async () => {
    const classNode = await firstExpression(
      "class Types::CampaignType < Types::BaseObject\nend\n",
    );
    const wrapper = field(classNode, "superclass");
    expect(wrapper?.namedChild(0)?.text).toBe("Types::BaseObject");
  });
});
