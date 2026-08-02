import path from "node:path";

import { Node, Project, SyntaxKind } from "ts-morph";
import { describe, expect, it } from "vitest";

import { testCompilerOptions } from "@suss/test-project";

import { collectAncestorBranches } from "./conditions.js";
import { computePathConditions } from "./paths/pathConditions.js";

import type { FunctionRoot } from "./conditions.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FIXTURES_DIR = path.resolve(__dirname, "../../../../fixtures/conditions");

// One project for every fixture in this file. Each fixture has its own
// path, so nothing here collides.
const fixtures = new Project({ compilerOptions: testCompilerOptions });

function loadFixture(filename: string) {
  return fixtures.addSourceFileAtPath(path.join(FIXTURES_DIR, filename));
}

/** Find a function (declaration or arrow) by its name in the source file. */
function getFunction(
  sourceFile: ReturnType<typeof loadFixture>,
  name: string,
): FunctionRoot {
  // Try function declarations first
  const decl = sourceFile.getFunction(name);
  if (decl !== undefined) {
    return decl;
  }

  // Try variable declarations holding arrow functions
  const varDecl = sourceFile.getVariableDeclaration(name);
  if (varDecl !== undefined) {
    const init = varDecl.getInitializer();
    if (init !== undefined && Node.isArrowFunction(init)) {
      return init;
    }
  }

  throw new Error(`Function "${name}" not found in source file`);
}

/** Collect all ReturnStatement nodes that are direct or indirect children of a function. */
function getReturnNodes(func: FunctionRoot) {
  return func.getDescendantsOfKind(SyntaxKind.ReturnStatement);
}

// ---------------------------------------------------------------------------
// fixture-if-else.ts
// ---------------------------------------------------------------------------

describe("fixture-if-else.ts — collectAncestorBranches", () => {
  const sourceFile = loadFixture("fixture-if-else.ts");
  const func = getFunction(sourceFile, "twoPath");
  const returns = getReturnNodes(func);

  it("finds 2 return statements", () => {
    expect(returns).toHaveLength(2);
  });

  it("then-branch return has positive condition 'x > 0'", () => {
    // The first return is in the then-branch
    const [thenReturn] = returns;
    const conditions = collectAncestorBranches(thenReturn, func);
    expect(conditions).toHaveLength(1);
    expect(conditions[0].sourceText).toBe("x > 0");
    expect(conditions[0].polarity).toBe("positive");
    expect(conditions[0].source).toBe("explicit");
    expect(conditions[0].structured).toBeNull();
  });

  it("else-branch return has negative condition 'x > 0'", () => {
    // The second return is in the else-branch
    const elseReturn = returns[1];
    const conditions = collectAncestorBranches(elseReturn, func);
    expect(conditions).toHaveLength(1);
    expect(conditions[0].sourceText).toBe("x > 0");
    expect(conditions[0].polarity).toBe("negative");
    expect(conditions[0].source).toBe("explicit");
  });
});

// ---------------------------------------------------------------------------
// fixture-early-returns.ts
// ---------------------------------------------------------------------------

describe("fixture-early-returns.ts — guard chains via the path engine", () => {
  const sourceFile = loadFixture("fixture-early-returns.ts");
  const func = getFunction(sourceFile, "guardedHandler");
  const returns = getReturnNodes(func);

  it("finds 4 return statements", () => {
    expect(returns).toHaveLength(4);
  });

  it("each return carries exactly the guards passed before it", () => {
    const result = computePathConditions(func, returns);
    const sigs = returns.map((r) =>
      (result.byTerminal.get(r) ?? []).map((path) =>
        path
          .map((c) => `${c.polarity}:${c.source}:${c.sourceText}`)
          .join(" ∧ "),
      ),
    );
    expect(sigs).toEqual([
      ["positive:explicit:!id"],
      ["negative:earlyReturn:!id ∧ positive:explicit:!user"],
      [
        "negative:earlyReturn:!id ∧ negative:earlyReturn:!user ∧ positive:explicit:!user.isActive",
      ],
      [
        "negative:earlyReturn:!id ∧ negative:earlyReturn:!user ∧ negative:earlyReturn:!user.isActive",
      ],
    ]);
  });
});

// ---------------------------------------------------------------------------
// fixture-switch.ts
// ---------------------------------------------------------------------------

describe("fixture-switch.ts — collectAncestorBranches", () => {
  const sourceFile = loadFixture("fixture-switch.ts");
  const func = getFunction(sourceFile, "statusHandler");
  const returns = getReturnNodes(func);

  it("finds 3 return statements", () => {
    expect(returns).toHaveLength(3);
  });

  it("first case ('active') has condition 'status === \"active\"'", () => {
    const [r0] = returns;
    const conditions = collectAncestorBranches(r0, func);
    expect(conditions).toHaveLength(1);
    expect(conditions[0].sourceText).toBe('status === "active"');
    expect(conditions[0].polarity).toBe("positive");
    expect(conditions[0].source).toBe("explicit");
  });

  it("second case ('deleted') has condition 'status === \"deleted\"'", () => {
    const r1 = returns[1];
    const conditions = collectAncestorBranches(r1, func);
    expect(conditions).toHaveLength(1);
    expect(conditions[0].sourceText).toBe('status === "deleted"');
    expect(conditions[0].polarity).toBe("positive");
  });

  it("default case return has no ancestor conditions (DefaultClause, not CaseClause)", () => {
    const r2 = returns[2];
    const conditions = collectAncestorBranches(r2, func);
    // DefaultClause is not a CaseClause, so no condition is recorded
    expect(conditions).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// fixture-switch-fallthrough.ts — fallthrough + nested block cases
// ---------------------------------------------------------------------------

describe("fixture-switch-fallthrough.ts — classify fallthrough", () => {
  const sourceFile = loadFixture("fixture-switch-fallthrough.ts");
  const func = getFunction(sourceFile, "classify");
  const returns = getReturnNodes(func);

  it("finds three returns — the fallthrough case ('a') has no body of its own", () => {
    expect(returns).toHaveLength(3);
  });

  it("the 'ab' return picks up both case labels via fallthrough — `kind === 'a' || kind === 'b'`", () => {
    const r = returns[0];
    const conditions = collectAncestorBranches(r, func);
    expect(conditions).toHaveLength(1);
    expect(conditions[0].sourceText).toBe('kind === "a" || kind === "b"');
  });

  it("the 'c' case return picks up its case label", () => {
    const r = returns[1];
    const conditions = collectAncestorBranches(r, func);
    expect(conditions).toHaveLength(1);
    expect(conditions[0].sourceText).toBe('kind === "c"');
  });

  it("default return has no ancestor conditions today", () => {
    const r = returns[2];
    const conditions = collectAncestorBranches(r, func);
    expect(conditions).toHaveLength(0);
  });
});

describe("fixture-switch-fallthrough.ts — classifyBlock nested-block case", () => {
  const sourceFile = loadFixture("fixture-switch-fallthrough.ts");
  const func = getFunction(sourceFile, "classifyBlock");
  const returns = getReturnNodes(func);

  it("case with a block body still picks up the case label", () => {
    const r = returns[0];
    const conditions = collectAncestorBranches(r, func);
    expect(conditions).toHaveLength(1);
    expect(conditions[0].sourceText).toBe('kind === "x"');
  });

  it("default with a block body has no ancestor conditions today", () => {
    const r = returns[1];
    const conditions = collectAncestorBranches(r, func);
    expect(conditions).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// fixture-try-catch.ts
// ---------------------------------------------------------------------------

describe("fixture-try-catch.ts — collectAncestorBranches", () => {
  const sourceFile = loadFixture("fixture-try-catch.ts");
  const func = getFunction(sourceFile, "risky");
  const returns = getReturnNodes(func);

  it("finds 2 return statements", () => {
    expect(returns).toHaveLength(2);
  });

  it("try-block return has no ancestor conditions", () => {
    const [tryReturn] = returns;
    const conditions = collectAncestorBranches(tryReturn, func);
    expect(conditions).toHaveLength(0);
  });

  it("catch-block return has 'catch' condition with source 'catchBlock'", () => {
    const catchReturn = returns[1];
    const conditions = collectAncestorBranches(catchReturn, func);
    expect(conditions).toHaveLength(1);
    expect(conditions[0].sourceText).toBe("catch");
    expect(conditions[0].polarity).toBe("positive");
    expect(conditions[0].source).toBe("catchBlock");
    expect(conditions[0].structured).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// fixture-nested.ts — exercises both functions together
// ---------------------------------------------------------------------------

describe("fixture-nested.ts — ancestor walk + early returns combined", () => {
  const sourceFile = loadFixture("fixture-nested.ts");
  const func = getFunction(sourceFile, "nested");
  const returns = getReturnNodes(func);

  it("finds 3 return statements", () => {
    // "both", "just-a", "neither"
    expect(returns).toHaveLength(3);
  });

  it("'both' return: ancestor conditions are [a (positive), b (positive)]", () => {
    // return "both" is inside if(a) { if(b) { ... } }
    const bothReturn = returns[0];
    const conditions = collectAncestorBranches(bothReturn, func);
    expect(conditions).toHaveLength(2);
    expect(conditions[0].sourceText).toBe("a");
    expect(conditions[0].polarity).toBe("positive");
    expect(conditions[1].sourceText).toBe("b");
    expect(conditions[1].polarity).toBe("positive");
  });

  it("'just-a' return: ancestor condition is [a (positive)]", () => {
    // return "just-a" is inside if(a) { ...; return "just-a"; }
    const justAReturn = returns[1];
    const conditions = collectAncestorBranches(justAReturn, func);
    expect(conditions).toHaveLength(1);
    expect(conditions[0].sourceText).toBe("a");
    expect(conditions[0].polarity).toBe("positive");
  });

  it("'just-a' return: the path engine carries the sibling guard 'b'", () => {
    // Inside if(a), `if (b) return "both"` is a prior sibling guard —
    // invisible to the deleted legacy collector, carried per-path now.
    const justAReturn = returns[1];
    const result = computePathConditions(func, [justAReturn]);
    const sigs = (result.byTerminal.get(justAReturn) ?? []).map((path) =>
      path.map((c) => `${c.polarity}:${c.sourceText}`).join(" ∧ "),
    );
    expect(sigs).toEqual(["positive:a ∧ negative:b"]);
  });

  it("'neither' return: no ancestor conditions", () => {
    const neitherReturn = returns[2];
    const conditions = collectAncestorBranches(neitherReturn, func);
    expect(conditions).toHaveLength(0);
  });

  it("'neither' return: the path engine records exactly [¬a]", () => {
    // The if(a) block always returns ("both" or "just-a"), so reaching
    // "neither" requires only ¬a. The deleted legacy collector recorded
    // the over-conjoined ¬a ∧ ¬b here — the unsoundness that motivated
    // the per-path engine.
    const neitherReturn = returns[2];
    const result = computePathConditions(func, [neitherReturn]);
    const sigs = (result.byTerminal.get(neitherReturn) ?? []).map((path) =>
      path.map((c) => `${c.polarity}:${c.sourceText}`).join(" ∧ "),
    );
    expect(sigs).toEqual(["negative:a"]);
  });
});
