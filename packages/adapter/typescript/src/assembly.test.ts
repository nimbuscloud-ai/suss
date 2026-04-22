// assembly.test.ts — Tests for extractRawBranches (Task 2.5)

import { Project } from "ts-morph";
import { describe, expect, it } from "vitest";

import { extractRawBranches } from "./assembly.js";

import type { TerminalPattern } from "@suss/extractor";
import type { FunctionRoot } from "./conditions.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createProject() {
  return new Project({ useInMemoryFileSystem: true });
}

/** Get the first exported function from the source file. */
function getExportedFunction(project: Project, source: string): FunctionRoot {
  const file = project.createSourceFile("test.ts", source);
  const fn = file.getFunctions().find((f) => f.isExported());
  if (fn === undefined) {
    throw new Error("No exported function found");
  }
  return fn;
}

// ---------------------------------------------------------------------------
// Framework terminal patterns (copied from the framework packs)
// ---------------------------------------------------------------------------

const tsRestTerminals: TerminalPattern[] = [
  {
    kind: "response",
    match: {
      type: "returnShape",
      requiredProperties: ["status", "body"],
    },
    extraction: {
      statusCode: { from: "property", name: "status" },
      body: { from: "property", name: "body" },
    },
  },
];

const expressTerminals: TerminalPattern[] = [
  {
    kind: "response",
    match: {
      type: "parameterMethodCall",
      parameterPosition: 1,
      methodChain: ["status", "json"],
    },
    extraction: {
      statusCode: { from: "argument", position: 0 },
      body: { from: "argument", position: 0 },
    },
  },
  {
    kind: "response",
    match: {
      type: "parameterMethodCall",
      parameterPosition: 1,
      methodChain: ["json"],
    },
    extraction: {
      body: { from: "argument", position: 0 },
    },
  },
];

const reactRouterTerminals: TerminalPattern[] = [
  {
    kind: "return",
    match: { type: "returnShape" },
    extraction: {
      body: { from: "argument", position: 0 },
    },
  },
  {
    kind: "throw",
    match: {
      type: "throwExpression",
      constructorPattern: "httpErrorJson",
    },
    extraction: {
      statusCode: { from: "argument", position: 0 },
      body: { from: "argument", position: 1 },
    },
  },
];

// ---------------------------------------------------------------------------
// ts-rest style
// ---------------------------------------------------------------------------

describe("ts-rest style — returnShape", () => {
  it("extracts a single unconditional branch as default", () => {
    const project = createProject();
    const fn = getExportedFunction(
      project,
      `
      export async function handler({ params }: any) {
        return { status: 200, body: { id: params.id } };
      }
    `,
    );

    const branches = extractRawBranches(fn, tsRestTerminals);
    expect(branches).toHaveLength(1);
    expect(branches[0].conditions).toHaveLength(0);
    expect(branches[0].isDefault).toBe(true);
    expect(branches[0].terminal.kind).toBe("response");
    expect(branches[0].terminal.statusCode).toEqual({
      type: "literal",
      value: 200,
    });
  });

  it("extracts branches from if/else with structured predicates", () => {
    const project = createProject();
    const fn = getExportedFunction(
      project,
      `
      export async function handler({ params }: any) {
        const user = await db.findById(params.id);
        if (!user) {
          return { status: 404, body: { error: "not found" } };
        }
        return { status: 200, body: user };
      }
    `,
    );

    const branches = extractRawBranches(fn, tsRestTerminals);
    expect(branches).toHaveLength(2);

    // First branch: if (!user) → 404
    const b404 = branches.find(
      (b) =>
        b.terminal.statusCode?.type === "literal" &&
        b.terminal.statusCode.value === 404,
    );
    expect(b404).toBeDefined();
    expect(b404?.conditions).toHaveLength(1);
    expect(b404?.conditions[0].polarity).toBe("positive");
    expect(b404?.conditions[0].source).toBe("explicit");
    expect(b404?.isDefault).toBe(false);
    // structured should be a negation/truthinessCheck, not null
    expect(b404?.conditions[0].structured).not.toBeNull();
    expect(b404?.conditions[0].structured?.type).toBe("truthinessCheck");

    // Second branch: 200 — has early return condition (negative polarity)
    const b200 = branches.find(
      (b) =>
        b.terminal.statusCode?.type === "literal" &&
        b.terminal.statusCode.value === 200,
    );
    expect(b200).toBeDefined();
    expect(b200?.conditions).toHaveLength(1);
    expect(b200?.conditions[0].polarity).toBe("negative");
    expect(b200?.conditions[0].source).toBe("earlyReturn");
    // isDefault: true because all conditions are earlyReturn
    expect(b200?.isDefault).toBe(true);
  });

  it("fills in structured predicates for comparisons", () => {
    const project = createProject();
    const fn = getExportedFunction(
      project,
      `
      export async function handler({ params }: any) {
        if (params.type === "admin") {
          return { status: 200, body: { admin: true } };
        }
        return { status: 200, body: { admin: false } };
      }
    `,
    );

    const branches = extractRawBranches(fn, tsRestTerminals);
    expect(branches).toHaveLength(2);

    // The if-branch should have a comparison predicate
    const ifBranch = branches[0];
    expect(ifBranch.conditions).toHaveLength(1);
    expect(ifBranch.conditions[0].structured).not.toBeNull();
    expect(ifBranch.conditions[0].structured?.type).toBe("comparison");
  });

  it("handles arrow expression body (concise return)", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "test.ts",
      `
      export const handler = async ({ params }: any) => ({
        status: 200,
        body: { id: params.id },
      });
    `,
    );

    // Arrow expression body — get the arrow function from the variable
    const varDecl = file.getVariableDeclarations()[0];
    const arrowFn = varDecl.getInitializerOrThrow() as FunctionRoot;

    const branches = extractRawBranches(arrowFn, tsRestTerminals);
    expect(branches).toHaveLength(1);
    expect(branches[0].terminal.kind).toBe("response");
    expect(branches[0].terminal.statusCode).toEqual({
      type: "literal",
      value: 200,
    });
    expect(branches[0].isDefault).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Express style
// ---------------------------------------------------------------------------

describe("Express style — parameterMethodCall", () => {
  it("extracts res.status(N).json(body) terminal", () => {
    const project = createProject();
    const fn = getExportedFunction(
      project,
      `
      export function handler(req: any, res: any) {
        res.status(200).json({ users: [] });
      }
    `,
    );

    const branches = extractRawBranches(fn, expressTerminals);
    expect(branches).toHaveLength(1);
    expect(branches[0].terminal.kind).toBe("response");
    expect(branches[0].terminal.statusCode).toEqual({
      type: "literal",
      value: 200,
    });
    expect(branches[0].isDefault).toBe(true);
  });

  it("extracts conditional branches with res.json()", () => {
    const project = createProject();
    const fn = getExportedFunction(
      project,
      `
      export function handler(req: any, res: any) {
        const id = req.params.id;
        if (!id) {
          return res.status(400).json({ error: "missing id" });
        }
        res.json({ id });
      }
    `,
    );

    const branches = extractRawBranches(fn, expressTerminals);
    expect(branches).toHaveLength(2);

    // 400 branch: inside if(!id)
    const b400 = branches.find(
      (b) =>
        b.terminal.statusCode?.type === "literal" &&
        b.terminal.statusCode.value === 400,
    );
    expect(b400).toBeDefined();
    expect(b400?.conditions).toHaveLength(1);
    expect(b400?.conditions[0].structured).not.toBeNull();
    expect(b400?.isDefault).toBe(false);

    // json() branch: has early return condition
    const bJson = branches.find((b) => b.terminal.statusCode === null);
    expect(bJson).toBeDefined();
    expect(bJson?.conditions).toHaveLength(1);
    expect(bJson?.conditions[0].source).toBe("earlyReturn");
    expect(bJson?.isDefault).toBe(true);
  });

  it("handles multiple sequential if-guards", () => {
    const project = createProject();
    const fn = getExportedFunction(
      project,
      `
      export function handler(req: any, res: any) {
        if (!req.params.id) {
          return res.status(400).json({ error: "missing id" });
        }
        if (!req.user) {
          return res.status(401).json({ error: "unauthorized" });
        }
        res.status(200).json({ ok: true });
      }
    `,
    );

    const branches = extractRawBranches(fn, expressTerminals);
    expect(branches).toHaveLength(3);

    // Final 200: should have two early return conditions (both negative)
    const b200 = branches.find(
      (b) =>
        b.terminal.statusCode?.type === "literal" &&
        b.terminal.statusCode.value === 200,
    );
    expect(b200).toBeDefined();
    expect(b200?.conditions).toHaveLength(2);
    expect(b200?.conditions.every((c) => c.polarity === "negative")).toBe(true);
    expect(
      b200?.conditions.every(
        (c) => c.source === "earlyReturn" || c.source === "earlyThrow",
      ),
    ).toBe(true);
    expect(b200?.isDefault).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// React Router style
// ---------------------------------------------------------------------------

describe("React Router style — returnShape + throwExpression", () => {
  it("extracts return and throw terminals", () => {
    const project = createProject();
    const fn = getExportedFunction(
      project,
      `
      export async function loader({ params }: any) {
        const user = await db.findById(params.id);
        if (!user) {
          throw httpErrorJson(404, { error: "not found" });
        }
        return { name: user.name };
      }
    `,
    );

    const branches = extractRawBranches(fn, reactRouterTerminals);
    expect(branches).toHaveLength(2);

    const throwBranch = branches.find((b) => b.terminal.kind === "throw");
    expect(throwBranch).toBeDefined();
    expect(throwBranch?.terminal.statusCode).toEqual({
      type: "literal",
      value: 404,
    });
    expect(throwBranch?.conditions).toHaveLength(1);
    expect(throwBranch?.conditions[0].polarity).toBe("positive");

    const returnBranch = branches.find((b) => b.terminal.kind === "return");
    expect(returnBranch).toBeDefined();
    // Early throw condition
    expect(returnBranch?.conditions).toHaveLength(1);
    expect(returnBranch?.conditions[0].source).toBe("earlyThrow");
    expect(returnBranch?.conditions[0].polarity).toBe("negative");
    expect(returnBranch?.isDefault).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// try/catch
// ---------------------------------------------------------------------------

describe("try/catch", () => {
  it("records catchBlock condition for terminal inside catch", () => {
    const project = createProject();
    const fn = getExportedFunction(
      project,
      `
      export async function handler({ params }: any) {
        try {
          const data = await fetchData(params.id);
          return { status: 200, body: data };
        } catch (err) {
          return { status: 500, body: { error: "internal" } };
        }
      }
    `,
    );

    const branches = extractRawBranches(fn, tsRestTerminals);
    expect(branches).toHaveLength(2);

    const catchBranch = branches.find(
      (b) =>
        b.terminal.statusCode?.type === "literal" &&
        b.terminal.statusCode.value === 500,
    );
    expect(catchBranch).toBeDefined();
    expect(catchBranch?.conditions).toHaveLength(1);
    expect(catchBranch?.conditions[0].source).toBe("catchBlock");
    expect(catchBranch?.conditions[0].structured).toBeNull();
    expect(catchBranch?.isDefault).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Nested if/else-if chain
// ---------------------------------------------------------------------------

describe("if / else-if chain", () => {
  it("extracts separate branches for if / else-if / else", () => {
    const project = createProject();
    const fn = getExportedFunction(
      project,
      `
      export function handler({ params }: any) {
        if (params.role === "admin") {
          return { status: 200, body: { level: "admin" } };
        } else if (params.role === "user") {
          return { status: 200, body: { level: "user" } };
        } else {
          return { status: 403, body: { error: "forbidden" } };
        }
      }
    `,
    );

    const branches = extractRawBranches(fn, tsRestTerminals);
    expect(branches).toHaveLength(3);

    // First branch: positive condition
    expect(branches[0].conditions).toHaveLength(1);
    expect(branches[0].conditions[0].polarity).toBe("positive");
    expect(branches[0].conditions[0].structured).not.toBeNull();
    expect(branches[0].conditions[0].structured?.type).toBe("comparison");

    // Second branch: negative outer + positive inner
    expect(branches[1].conditions).toHaveLength(2);
    expect(branches[1].conditions[0].polarity).toBe("negative");
    expect(branches[1].conditions[1].polarity).toBe("positive");

    // Third branch: two negative conditions (else of both ifs)
    expect(branches[2].conditions).toHaveLength(2);
    expect(branches[2].conditions[0].polarity).toBe("negative");
    expect(branches[2].conditions[1].polarity).toBe("negative");
  });
});

// ---------------------------------------------------------------------------
// switch/case
// ---------------------------------------------------------------------------

describe("switch/case", () => {
  it("extracts synthetic conditions for switch cases", () => {
    const project = createProject();
    const fn = getExportedFunction(
      project,
      `
      export function handler({ params }: any) {
        switch (params.type) {
          case "a":
            return { status: 200, body: { type: "a" } };
          case "b":
            return { status: 201, body: { type: "b" } };
        }
        return { status: 400, body: { error: "unknown type" } };
      }
    `,
    );

    const branches = extractRawBranches(fn, tsRestTerminals);
    expect(branches).toHaveLength(3);

    // Switch case conditions are synthetic (expression is null → structured is null)
    const caseA = branches.find(
      (b) =>
        b.conditions.length > 0 && b.conditions[0].sourceText.includes('"a"'),
    );
    expect(caseA).toBeDefined();
    expect(caseA?.conditions[0].structured).toBeNull();
    expect(caseA?.conditions[0].source).toBe("explicit");

    // The fallthrough branch (400) has no conditions
    const b400 = branches.find(
      (b) =>
        b.terminal.statusCode?.type === "literal" &&
        b.terminal.statusCode.value === 400,
    );
    expect(b400).toBeDefined();
    expect(b400?.isDefault).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// effects and location
// ---------------------------------------------------------------------------

describe("metadata", () => {
  it("effects are empty for v0", () => {
    const project = createProject();
    const fn = getExportedFunction(
      project,
      `
      export function handler({ params }: any) {
        return { status: 200, body: {} };
      }
    `,
    );

    const branches = extractRawBranches(fn, tsRestTerminals);
    expect(branches[0].effects).toEqual([]);
  });

  it("location matches the terminal location", () => {
    const project = createProject();
    const fn = getExportedFunction(
      project,
      `
      export function handler({ params }: any) {
        return { status: 200, body: {} };
      }
    `,
    );

    const branches = extractRawBranches(fn, tsRestTerminals);
    expect(branches[0].location).toEqual(branches[0].terminal.location);
    expect(branches[0].location.start).toBeGreaterThan(0);
    expect(branches[0].location.end).toBeGreaterThanOrEqual(
      branches[0].location.start,
    );
  });
});

// ---------------------------------------------------------------------------
// nested conditions
// ---------------------------------------------------------------------------

describe("nested conditions", () => {
  it("collects multiple ancestor conditions outermost to innermost", () => {
    const project = createProject();
    const fn = getExportedFunction(
      project,
      `
      export function handler({ params }: any) {
        if (params.authenticated) {
          if (params.admin) {
            return { status: 200, body: { secret: true } };
          }
        }
        return { status: 403, body: { error: "forbidden" } };
      }
    `,
    );

    const branches = extractRawBranches(fn, tsRestTerminals);
    expect(branches).toHaveLength(2);

    const secretBranch = branches.find((b) => b.conditions.length === 2);
    expect(secretBranch).toBeDefined();
    // Outermost first
    expect(secretBranch?.conditions[0].sourceText).toBe("params.authenticated");
    expect(secretBranch?.conditions[1].sourceText).toBe("params.admin");
    expect(secretBranch?.isDefault).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Mixed early returns + ancestor conditions
// ---------------------------------------------------------------------------

describe("mixed early returns + ancestor conditions", () => {
  it("early return conditions come before ancestor conditions", () => {
    const project = createProject();
    const fn = getExportedFunction(
      project,
      `
      export async function handler({ params }: any) {
        if (!params.id) {
          return { status: 400, body: { error: "missing id" } };
        }
        if (params.role === "admin") {
          return { status: 200, body: { admin: true } };
        }
        return { status: 200, body: { admin: false } };
      }
    `,
    );

    const branches = extractRawBranches(fn, tsRestTerminals);
    expect(branches).toHaveLength(3);

    // The admin branch: early return (!params.id) + ancestor (role === "admin")
    const adminBranch = branches.find(
      (b) =>
        b.conditions.length === 2 &&
        b.conditions.some((c) => c.source === "earlyReturn") &&
        b.conditions.some((c) => c.source === "explicit"),
    );
    expect(adminBranch).toBeDefined();
    // Early return comes first
    expect(adminBranch?.conditions[0].source).toBe("earlyReturn");
    expect(adminBranch?.conditions[0].polarity).toBe("negative");
    // Ancestor condition comes second
    expect(adminBranch?.conditions[1].source).toBe("explicit");
    expect(adminBranch?.conditions[1].polarity).toBe("positive");
    // Has an explicit condition, so NOT default
    expect(adminBranch?.isDefault).toBe(false);

    // Final branch: two early returns, no explicit → isDefault
    const fallthrough = branches.find(
      (b) =>
        b.conditions.length === 2 &&
        b.conditions.every(
          (c) => c.source === "earlyReturn" || c.source === "earlyThrow",
        ),
    );
    expect(fallthrough).toBeDefined();
    expect(fallthrough?.isDefault).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Compound predicates (&&, ||)
// ---------------------------------------------------------------------------

describe("compound predicates through assembly", () => {
  it("if (a && b) produces a compound predicate", () => {
    const project = createProject();
    const fn = getExportedFunction(
      project,
      `
      export function handler({ params }: any) {
        if (params.active && params.verified) {
          return { status: 200, body: { ok: true } };
        }
        return { status: 403, body: { error: "not ready" } };
      }
    `,
    );

    const branches = extractRawBranches(fn, tsRestTerminals);
    expect(branches).toHaveLength(2);

    const okBranch = branches[0];
    expect(okBranch.conditions).toHaveLength(1);
    expect(okBranch.conditions[0].structured).not.toBeNull();
    expect(okBranch.conditions[0].structured?.type).toBe("compound");
    if (okBranch.conditions[0].structured?.type === "compound") {
      expect(okBranch.conditions[0].structured?.op).toBe("and");
      expect(okBranch.conditions[0].structured?.operands).toHaveLength(2);
    }
  });

  it("if (a || b) produces a compound predicate", () => {
    const project = createProject();
    const fn = getExportedFunction(
      project,
      `
      export function handler({ params }: any) {
        if (params.deleted || params.banned) {
          return { status: 410, body: { error: "gone" } };
        }
        return { status: 200, body: {} };
      }
    `,
    );

    const branches = extractRawBranches(fn, tsRestTerminals);
    const goneBranch = branches[0];
    expect(goneBranch.conditions[0].structured).not.toBeNull();
    expect(goneBranch.conditions[0].structured?.type).toBe("compound");
    if (goneBranch.conditions[0].structured?.type === "compound") {
      expect(goneBranch.conditions[0].structured?.op).toBe("or");
    }
  });
});

// ---------------------------------------------------------------------------
// Null check predicates
// ---------------------------------------------------------------------------

describe("null check predicates through assembly", () => {
  it("if (x === null) produces a nullCheck predicate", () => {
    const project = createProject();
    const fn = getExportedFunction(
      project,
      `
      export function handler({ params }: any) {
        const user = getUser(params.id);
        if (user === null) {
          return { status: 404, body: { error: "not found" } };
        }
        return { status: 200, body: user };
      }
    `,
    );

    const branches = extractRawBranches(fn, tsRestTerminals);
    const notFoundBranch = branches[0];
    expect(notFoundBranch.conditions[0].structured).not.toBeNull();
    expect(notFoundBranch.conditions[0].structured?.type).toBe("nullCheck");
  });

  it("if (x !== undefined) produces a nullCheck with negated: true", () => {
    const project = createProject();
    const fn = getExportedFunction(
      project,
      `
      export function handler({ params }: any) {
        const cached = getCached(params.key);
        if (cached !== undefined) {
          return { status: 200, body: cached };
        }
        return { status: 200, body: computeFresh() };
      }
    `,
    );

    const branches = extractRawBranches(fn, tsRestTerminals);
    const cachedBranch = branches[0];
    expect(cachedBranch.conditions[0].structured).not.toBeNull();
    expect(cachedBranch.conditions[0].structured?.type).toBe("nullCheck");
    if (cachedBranch.conditions[0].structured?.type === "nullCheck") {
      expect(cachedBranch.conditions[0].structured?.negated).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Call predicates
// ---------------------------------------------------------------------------

describe("call predicates through assembly", () => {
  it("if (isAdmin(user)) produces a call predicate", () => {
    const project = createProject();
    const fn = getExportedFunction(
      project,
      `
      export function handler({ params }: any) {
        const user = getUser(params.id);
        if (isAdmin(user)) {
          return { status: 200, body: { secret: true } };
        }
        return { status: 200, body: {} };
      }
    `,
    );

    const branches = extractRawBranches(fn, tsRestTerminals);
    const adminBranch = branches[0];
    expect(adminBranch.conditions[0].structured).not.toBeNull();
    expect(adminBranch.conditions[0].structured?.type).toBe("call");
    if (adminBranch.conditions[0].structured?.type === "call") {
      expect(adminBranch.conditions[0].structured?.callee).toBe("isAdmin");
    }
  });
});

// ---------------------------------------------------------------------------
// try/catch + nested conditions
// ---------------------------------------------------------------------------

describe("try/catch + nested conditions", () => {
  it("terminal in catch + if gets both catchBlock and explicit conditions", () => {
    const project = createProject();
    const fn = getExportedFunction(
      project,
      `
      export async function handler({ params }: any) {
        try {
          const data = await fetchData(params.id);
          return { status: 200, body: data };
        } catch (err: any) {
          if (err.code === "NOT_FOUND") {
            return { status: 404, body: { error: "not found" } };
          }
          return { status: 500, body: { error: "internal" } };
        }
      }
    `,
    );

    const branches = extractRawBranches(fn, tsRestTerminals);
    expect(branches).toHaveLength(3);

    // 404 branch: catch + if condition
    const b404 = branches.find(
      (b) =>
        b.terminal.statusCode?.type === "literal" &&
        b.terminal.statusCode.value === 404,
    );
    expect(b404).toBeDefined();
    expect(b404?.conditions).toHaveLength(2);
    // catchBlock first (outermost), then explicit if condition
    expect(b404?.conditions[0].source).toBe("catchBlock");
    expect(b404?.conditions[1].source).toBe("explicit");
    expect(b404?.conditions[1].structured).not.toBeNull();
    expect(b404?.conditions[1].structured?.type).toBe("comparison");
    expect(b404?.isDefault).toBe(false);

    // 500 branch: catch + early return from inner if
    const b500 = branches.find(
      (b) =>
        b.terminal.statusCode?.type === "literal" &&
        b.terminal.statusCode.value === 500,
    );
    expect(b500).toBeDefined();
    // catch condition only — the inner if's guard is an early return within catch
    const catchConditions = b500?.conditions.filter(
      (c) => c.source === "catchBlock",
    );
    expect(catchConditions).toHaveLength(1);
    expect(b500?.isDefault).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Early throw + early return mixed
// ---------------------------------------------------------------------------

describe("mixed early throw + early return", () => {
  it("distinguishes earlyReturn and earlyThrow sources", () => {
    const project = createProject();
    const fn = getExportedFunction(
      project,
      `
      export async function handler({ params }: any) {
        if (!params.id) {
          throw new Error("missing id");
        }
        if (!params.auth) {
          return { status: 401, body: { error: "unauthorized" } };
        }
        return { status: 200, body: { ok: true } };
      }
    `,
    );

    // The throw won't match tsRestTerminals (no throwExpression pattern),
    // but the early-throw guard still produces a condition on subsequent branches
    const branches = extractRawBranches(fn, tsRestTerminals);
    expect(branches).toHaveLength(2);

    // Final 200 branch: earlyThrow (!params.id) + earlyReturn (!params.auth)
    const b200 = branches.find(
      (b) =>
        b.terminal.statusCode?.type === "literal" &&
        b.terminal.statusCode.value === 200,
    );
    expect(b200).toBeDefined();
    expect(b200?.conditions).toHaveLength(2);
    expect(b200?.conditions[0].source).toBe("earlyThrow");
    expect(b200?.conditions[1].source).toBe("earlyReturn");
    expect(b200?.isDefault).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Realistic multi-layer handler (ts-rest style)
// ---------------------------------------------------------------------------

describe("realistic multi-layer handler", () => {
  it("handles guard → guard → try/catch → if/else (ts-rest style)", () => {
    const project = createProject();
    const fn = getExportedFunction(
      project,
      `
      export async function handler({ params, body: reqBody }: any) {
        if (!params.repoId) {
          return { status: 400, body: { error: "missing repoId" } };
        }
        if (!reqBody.branch) {
          return { status: 400, body: { error: "missing branch" } };
        }
        try {
          const repo = await db.repository.findUnique({ where: { id: params.repoId } });
          if (!repo) {
            return { status: 404, body: { error: "repo not found" } };
          }
          if (repo.archived) {
            return { status: 409, body: { error: "repo archived" } };
          }
          const result = await analyzeRepo(repo, reqBody.branch);
          return { status: 200, body: result };
        } catch (err) {
          return { status: 500, body: { error: "analysis failed" } };
        }
      }
    `,
    );

    const branches = extractRawBranches(fn, tsRestTerminals);
    expect(branches).toHaveLength(6);

    // 400 (missing repoId): 0 early returns, 1 explicit condition
    const b400a = branches[0];
    expect(b400a.conditions).toHaveLength(1);
    expect(b400a.conditions[0].source).toBe("explicit");
    expect(b400a.isDefault).toBe(false);

    // 400 (missing branch): 1 early return from first guard + 1 explicit condition
    const b400b = branches[1];
    expect(b400b.conditions).toHaveLength(2);
    expect(b400b.conditions[0].source).toBe("earlyReturn");
    expect(b400b.conditions[1].source).toBe("explicit");

    // 404: 2 early returns + 1 explicit (!repo)
    const b404 = branches.find(
      (b) =>
        b.terminal.statusCode?.type === "literal" &&
        b.terminal.statusCode.value === 404,
    );
    expect(b404).toBeDefined();
    if (b404 === undefined) {
      throw new Error("expected b404 branch");
    }
    const b404EarlyReturns = b404.conditions.filter(
      (c) => c.source === "earlyReturn" || c.source === "earlyThrow",
    );
    const b404Explicit = b404.conditions.filter((c) => c.source === "explicit");
    expect(b404EarlyReturns.length).toBeGreaterThanOrEqual(2);
    expect(b404Explicit.length).toBeGreaterThanOrEqual(1);
    expect(b404?.isDefault).toBe(false);

    // 200: has early returns from all guards + early return from inner ifs
    const b200 = branches.find(
      (b) =>
        b.terminal.statusCode?.type === "literal" &&
        b.terminal.statusCode.value === 200,
    );
    expect(b200).toBeDefined();
    // Should have early returns from the outer guards, plus inner guards (!repo, repo.archived)
    expect(b200?.conditions.length).toBeGreaterThanOrEqual(2);

    // 500 (catch): has catch condition
    const b500 = branches.find(
      (b) =>
        b.terminal.statusCode?.type === "literal" &&
        b.terminal.statusCode.value === 500,
    );
    expect(b500).toBeDefined();
    expect(b500?.conditions.some((c) => c.source === "catchBlock")).toBe(true);

    // All structured predicates should be non-null where there's an expression
    for (const branch of branches) {
      for (const cond of branch.conditions) {
        if (cond.source !== "catchBlock" && !cond.sourceText.includes("===")) {
          // Truthiness checks and comparisons should all have structured
          expect(cond.structured).not.toBeNull();
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Realistic Express handler
// ---------------------------------------------------------------------------

describe("realistic Express handler", () => {
  it("handles guard → try/catch → conditional response", () => {
    const project = createProject();
    const fn = getExportedFunction(
      project,
      `
      export function handler(req: any, res: any) {
        if (!req.params.id) {
          return res.status(400).json({ error: "missing id" });
        }
        const user = getUser(req.params.id);
        if (user === null) {
          return res.status(404).json({ error: "not found" });
        }
        if (user.active && user.verified) {
          res.status(200).json({ user, fullAccess: true });
        } else {
          res.status(200).json({ user, fullAccess: false });
        }
      }
    `,
    );

    const branches = extractRawBranches(fn, expressTerminals);
    expect(branches).toHaveLength(4);

    // 400 branch: explicit condition
    expect(branches[0].conditions[0].source).toBe("explicit");
    expect(branches[0].conditions[0].structured?.type).toBe("truthinessCheck");

    // 404 branch: early return + explicit null check
    const b404 = branches.find(
      (b) =>
        b.terminal.statusCode?.type === "literal" &&
        b.terminal.statusCode.value === 404,
    );
    expect(b404).toBeDefined();
    expect(b404?.conditions.some((c) => c.source === "earlyReturn")).toBe(true);
    expect(
      b404?.conditions.some((c) => c.structured?.type === "nullCheck"),
    ).toBe(true);

    // fullAccess:true branch: early returns + compound condition (active && verified)
    const fullAccessBranch = branches.find((b) =>
      b.conditions.some((c) => c.structured?.type === "compound"),
    );
    expect(fullAccessBranch).toBeDefined();
    // Has early returns for the two guards plus the explicit compound condition
    expect(fullAccessBranch?.conditions.length).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// edge cases
// ---------------------------------------------------------------------------

describe("edge cases", () => {
  it("returns empty array for function with no matching terminals", () => {
    const project = createProject();
    const fn = getExportedFunction(
      project,
      `
      export function handler() {
        console.log("hello");
      }
    `,
    );

    const branches = extractRawBranches(fn, tsRestTerminals);
    expect(branches).toHaveLength(0);
  });

  it("emits a fall-through terminal when the pack opts in and nothing covers the default path", () => {
    const project = createProject();
    const fn = getExportedFunction(
      project,
      `
      export function handler() {
        setCount(1);
        onChange(1);
      }
    `,
    );

    const patterns: TerminalPattern[] = [
      { kind: "return", match: { type: "returnStatement" }, extraction: {} },
      {
        kind: "return",
        match: { type: "functionFallthrough" },
        extraction: {},
      },
    ];
    const branches = extractRawBranches(fn, patterns);
    expect(branches).toHaveLength(1);
    expect(branches[0].isDefault).toBe(true);
    // Invocation effects capture the body's bare calls.
    const callees = branches[0].effects
      .filter((e) => e.type === "invocation")
      .map((e) => (e.type === "invocation" ? e.callee : null));
    expect(callees).toEqual(["setCount", "onChange"]);
  });

  it("does not emit fall-through when the pack didn't opt in", () => {
    const project = createProject();
    const fn = getExportedFunction(
      project,
      `
      export function handler() {
        setCount(1);
      }
    `,
    );

    const patterns: TerminalPattern[] = [
      { kind: "return", match: { type: "returnStatement" }, extraction: {} },
    ];
    const branches = extractRawBranches(fn, patterns);
    expect(branches).toHaveLength(0);
  });

  it("does not emit fall-through when an existing default terminal covers the exit", () => {
    const project = createProject();
    const fn = getExportedFunction(
      project,
      `
      export function handler() {
        return { status: 200, body: { ok: true } };
      }
    `,
    );

    const patterns: TerminalPattern[] = [
      {
        kind: "response",
        match: { type: "returnShape", requiredProperties: ["status", "body"] },
        extraction: {
          statusCode: { from: "property", name: "status" },
          body: { from: "property", name: "body" },
        },
      },
      {
        kind: "return",
        match: { type: "functionFallthrough" },
        extraction: {},
      },
    ];
    const branches = extractRawBranches(fn, patterns);
    // Only one terminal — the explicit return — because it covers the
    // default path. Fall-through suppressed.
    expect(branches).toHaveLength(1);
  });

  it("invocation effects skip calls whose line matches a matched terminal", () => {
    // Express-style: `res.json(body)` at the end is the terminal.
    // Its expression-statement-ness would otherwise make it an
    // invocation effect too — the deduplication keeps it out.
    const project = createProject();
    const fn = getExportedFunction(
      project,
      `
      export function handler(req: any, res: any) {
        logger.info("entry");
        res.status(200).json({ ok: true });
      }
    `,
    );

    const patterns: TerminalPattern[] = [
      {
        kind: "response",
        match: {
          type: "parameterMethodCall",
          parameterPosition: 1,
          methodChain: ["status", "json"],
        },
        extraction: {
          statusCode: { from: "argument", position: 0 },
          body: { from: "argument", position: 0 },
        },
      },
    ];
    const branches = extractRawBranches(fn, patterns);
    expect(branches).toHaveLength(1);
    const callees = branches[0].effects
      .filter((e) => e.type === "invocation")
      .map((e) => (e.type === "invocation" ? e.callee : null));
    // logger.info shows up; res.status(...).json(...) doesn't
    // double-count because its line is a terminal line.
    expect(callees).toEqual(["logger.info"]);
  });

  it("captures literal-string args and object-literal fields on invocation effects", () => {
    // `findings.push({ kind: "X", severity: "error" })` is the
    // canonical error-taxonomy pattern. Without capturing the kind
    // field, readers can see that push happens but not which
    // finding was emitted.
    const project = createProject();
    const fn = getExportedFunction(
      project,
      `
      export function emit(findings: any[]) {
        findings.push({ kind: "scenarioCoverageGap", severity: "error" });
        logger.info("emitted");
      }
    `,
    );
    const patterns: TerminalPattern[] = [
      {
        kind: "return",
        match: { type: "functionFallthrough" },
        extraction: {},
      },
    ];
    const branches = extractRawBranches(fn, patterns);
    const pushEffect = branches[0].effects.find(
      (e) => e.type === "invocation" && e.callee === "findings.push",
    );
    expect(pushEffect).toBeDefined();
    if (pushEffect === undefined || pushEffect.type !== "invocation") {
      throw new Error("expected findings.push invocation");
    }
    expect(pushEffect.args).toEqual([
      {
        kind: "object",
        fields: {
          kind: { kind: "string", value: "scenarioCoverageGap" },
          severity: { kind: "string", value: "error" },
        },
      },
    ]);

    const loggerEffect = branches[0].effects.find(
      (e) => e.type === "invocation" && e.callee === "logger.info",
    );
    if (loggerEffect === undefined || loggerEffect.type !== "invocation") {
      throw new Error("expected logger.info invocation");
    }
    expect(loggerEffect.args).toEqual([{ kind: "string", value: "emitted" }]);
  });

  it("leaves non-literal args as null positional slots", () => {
    const project = createProject();
    const fn = getExportedFunction(
      project,
      `
      export function handler(input: any) {
        logger.info(input.message, 42, true);
      }
    `,
    );
    const patterns: TerminalPattern[] = [
      {
        kind: "return",
        match: { type: "functionFallthrough" },
        extraction: {},
      },
    ];
    const branches = extractRawBranches(fn, patterns);
    const effect = branches[0].effects[0];
    if (effect === undefined || effect.type !== "invocation") {
      throw new Error("expected invocation effect");
    }
    expect(effect.args).toEqual([
      null,
      { kind: "number", value: 42 },
      { kind: "boolean", value: true },
    ]);
  });

  it("captures spread calls in a returned array literal", () => {
    // Orchestrator pattern: checkPair composes sub-check results
    // via `return [...f(), ...g()]`. The spread's inner call is a
    // real invocation that fires when the array is built.
    const project = createProject();
    const fn = getExportedFunction(
      project,
      `
      export function runAll(input: any) {
        return [
          ...stepOne(input),
          ...stepTwo(input),
          ...stepThree(input),
        ];
      }
    `,
    );
    const patterns: TerminalPattern[] = [
      { kind: "return", match: { type: "returnStatement" }, extraction: {} },
    ];
    const branches = extractRawBranches(fn, patterns);
    expect(branches).toHaveLength(1);
    const callees = branches[0].effects
      .filter((e) => e.type === "invocation")
      .map((e) => (e.type === "invocation" ? e.callee : null));
    expect(callees).toEqual(["stepOne", "stepTwo", "stepThree"]);
  });

  it("captures direct call elements and property-value calls in a returned literal", () => {
    const project = createProject();
    const fn = getExportedFunction(
      project,
      `
      export function composeResult(input: any) {
        return {
          first: computeFirst(input),
          rest: [secondary(input), tertiary(input)],
        };
      }
    `,
    );
    const patterns: TerminalPattern[] = [
      { kind: "return", match: { type: "returnStatement" }, extraction: {} },
    ];
    const branches = extractRawBranches(fn, patterns);
    expect(branches).toHaveLength(1);
    const callees = branches[0].effects
      .filter((e) => e.type === "invocation")
      .map((e) => (e.type === "invocation" ? e.callee : null));
    expect(callees).toEqual(["computeFirst", "secondary", "tertiary"]);
  });

  it("container calls survive terminal-line dedup on single-line returns", () => {
    // `return [...f(), ...g()]` has the terminal (return statement)
    // and the spread calls all on the same line. Before the fix,
    // line-based dedup filtered out the container calls; now they
    // pass because they're tagged `neverTerminal`.
    const project = createProject();
    const fn = getExportedFunction(
      project,
      `
      export function oneLiner(input: any) { return [...foo(input), ...bar(input)]; }
    `,
    );
    const patterns: TerminalPattern[] = [
      { kind: "return", match: { type: "returnStatement" }, extraction: {} },
    ];
    const branches = extractRawBranches(fn, patterns);
    const callees = branches[0].effects
      .filter((e) => e.type === "invocation")
      .map((e) => (e.type === "invocation" ? e.callee : null));
    expect(callees).toEqual(["foo", "bar"]);
  });

  it("does not capture call expressions in argument positions", () => {
    // `foo(bar())` — bar is an argument to foo, not a composition
    // sibling. The expression-statement-level foo call IS captured;
    // the nested bar should not be double-captured.
    const project = createProject();
    const fn = getExportedFunction(
      project,
      `
      export function handler(input: any) {
        logger.info(formatMessage(input));
      }
    `,
    );
    const patterns: TerminalPattern[] = [
      {
        kind: "return",
        match: { type: "functionFallthrough" },
        extraction: {},
      },
    ];
    const branches = extractRawBranches(fn, patterns);
    const callees = branches[0].effects
      .filter((e) => e.type === "invocation")
      .map((e) => (e.type === "invocation" ? e.callee : null));
    expect(callees).toEqual(["logger.info"]);
  });

  it("handles deeply nested if chains (4 levels)", () => {
    const project = createProject();
    const fn = getExportedFunction(
      project,
      `
      export function handler({ params }: any) {
        if (params.a) {
          if (params.b) {
            if (params.c) {
              if (params.d) {
                return { status: 200, body: { deep: true } };
              }
            }
          }
        }
        return { status: 400, body: {} };
      }
    `,
    );

    const branches = extractRawBranches(fn, tsRestTerminals);
    const deepBranch = branches.find((b) => b.conditions.length === 4);
    expect(deepBranch).toBeDefined();
    expect(deepBranch?.conditions[0].sourceText).toBe("params.a");
    expect(deepBranch?.conditions[1].sourceText).toBe("params.b");
    expect(deepBranch?.conditions[2].sourceText).toBe("params.c");
    expect(deepBranch?.conditions[3].sourceText).toBe("params.d");
    if (deepBranch === undefined) {
      throw new Error("expected deepBranch");
    }
    // All should have structured truthinessCheck predicates
    for (const cond of deepBranch.conditions) {
      expect(cond.structured).not.toBeNull();
      expect(cond.structured?.type).toBe("truthinessCheck");
    }
  });
});
