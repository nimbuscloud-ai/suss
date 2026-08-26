import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { createTypeScriptAdapter } from "@suss/adapter-typescript";
import { createFixtureProject, createTestProject } from "@suss/test-project";

import { expressFramework } from "./index.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

// ---------------------------------------------------------------------------
// Fixture project: adds fixtures/express/*.ts to an in-memory ts-morph project
// ---------------------------------------------------------------------------

const fixturesDir = path.resolve(__dirname, "../../../../fixtures/express");

async function runAdapter(): Promise<BehavioralSummary[]> {
  const project = createFixtureProject(fixturesDir, "*.ts");

  const adapter = createTypeScriptAdapter({
    project,
    frameworks: [expressFramework()],
  });

  return await adapter.extractAll();
}

// ---------------------------------------------------------------------------
// Structural sanity checks: cheap, catch accidental changes to exported shape
// ---------------------------------------------------------------------------

describe("expressFramework: pack shape", () => {
  it("exposes the expected discovery, terminals, and inputMapping keys", () => {
    const pack = expressFramework();
    expect(pack.name).toBe("express");
    expect(pack.languages).toEqual(["typescript", "javascript"]);
    // Two registration-call patterns (Router, express) and the
    // registration-loop pattern every HTTP pack gets.
    expect(pack.discovery).toHaveLength(3);
    expect(pack.contractReading).toBeUndefined();
    expect(pack.inputMapping.type).toBe("positionalParams");
  });
});

// ---------------------------------------------------------------------------
// Integration: run the adapter against the express fixture
// ---------------------------------------------------------------------------

describe("expressFramework: a path built by joining strings", () => {
  const pathsOf = (summaries: BehavioralSummary[]): (string | null)[] =>
    summaries
      .map((one) => {
        const semantics = one.identity.boundaryBinding?.semantics;
        return semantics?.name === "rest" ? semantics.path : null;
      })
      .filter((one): one is string => one !== null)
      .sort();

  const extract = async (source: string): Promise<BehavioralSummary[]> => {
    const project = createTestProject();
    project.createSourceFile("app.ts", source);
    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [expressFramework()],
    });
    return await adapter.extractAll();
  };

  it("reads a route whose path is two literals joined", async () => {
    // Every other spelling of the same value already worked: a
    // literal, a const, an import, a template. A concatenation states
    // the same path written the other way.
    const summaries = await extract(`
      import express from "express";
      const app = express();
      app.get("/users" + "/:id", (req: any, res: any) => {
        res.status(200).json({});
      });
    `);
    expect(pathsOf(summaries)).toEqual(["/users/:id"]);
  });

  it("follows a const into either side of the join", async () => {
    const summaries = await extract(`
      import express from "express";
      const app = express();
      const base = "/users";
      const P = base + "/:id";
      app.get(P, (req: any, res: any) => {
        res.status(200).json({});
      });
    `);
    expect(pathsOf(summaries)).toEqual(["/users/:id"]);
  });

  it("claims nothing for a join with a side it cannot read", async () => {
    const summaries = await extract(`
      import express from "express";
      const app = express();
      export function mount(prefix: string) {
        app.get(prefix + "/:id", (req: any, res: any) => {
          res.status(200).json({});
        });
      }
    `);
    expect(pathsOf(summaries)).toEqual([]);
  });
});

describe("expressFramework: registration options", () => {
  it("expands the project's own helpers when config supplies them", () => {
    const pack = expressFramework({
      registrationHelpers: [
        {
          helperName: "registerCrud",
          registrations: [
            { method: "GET", pathTemplate: "/{1}", handlerArg: "{2}.list" },
          ],
        },
      ],
    });
    const template = pack.discovery.find(
      (d) => d.match.type === "registrationTemplate",
    );
    expect(template?.match).toMatchObject({ helperName: "registerCrud" });
  });

  it("guards the loop pattern with its own routable", () => {
    // Without the receiver, any loop over objects spelled
    // method/path/handler in a file importing express would read as
    // routes, and every finding on them would be wrong.
    const loop = expressFramework().discovery.find(
      (d) => d.match.type === "registrationLoop",
    );
    expect(loop?.match).toMatchObject({
      receiver: {
        importModule: "express",
        importNames: ["Router", "express"],
      },
    });
  });
});

describe("expressFramework: integration", () => {
  // ts-morph project setup dominates: build the summaries once and reuse.
  let summaries: BehavioralSummary[];
  beforeAll(async () => {
    summaries = await runAdapter();
  }, 90_000);

  it("discovers every router.<method> handler in the fixture", () => {
    // Each handler is found through its registration call. The pack's
    // `bindingExtraction` lifts the method (registration verb) and path
    // (arg 0 literal) off the registration call, so each handler gets a
    // REST boundary binding rather than the function-call fallback.
    expect(summaries).toHaveLength(4);
    for (const s of summaries) {
      expect(s.kind).toBe("handler");
      expect(s.identity.boundaryBinding?.transport).toBe("http");
      expect(s.identity.boundaryBinding?.recognition).toBe("express");
      expect(s.identity.boundaryBinding?.semantics.name).toBe("rest");
    }
    const paths = summaries
      .map((s) => {
        const sem = s.identity.boundaryBinding?.semantics;
        return sem?.name === "rest" ? sem.path : null;
      })
      .filter((p): p is string => p !== null)
      .sort();
    expect(paths).toEqual([
      "/moved",
      "/old-profile",
      "/users/:id",
      "/webhooks/:source",
    ]);
  });

  it('records router.all as the "*" method', () => {
    const webhook = summaries.find((s) => {
      const sem = s.identity.boundaryBinding?.semantics;
      return sem?.name === "rest" && sem.path === "/webhooks/:source";
    });
    const sem = webhook?.identity.boundaryBinding?.semantics;
    expect(sem?.name === "rest" ? sem.method : null).toBe("*");
    expect(webhook?.identity.nameKind).toBe("label");
  });

  it("never links a Promise.all call to the .all route handler", () => {
    const webhook = summaries.find((s) => {
      const sem = s.identity.boundaryBinding?.semantics;
      return sem?.name === "rest" && sem.path === "/webhooks/:source";
    });
    const invocations = (webhook?.transitions ?? [])
      .flatMap((t) => t.effects)
      .filter((e) => e.type === "invocation" && e.callee === "Promise.all");
    expect(invocations.length).toBeGreaterThan(0);
    for (const effect of invocations) {
      expect(effect.type === "invocation" ? effect.summary : null).toBe(
        undefined,
      );
    }
  });

  it("maps positional params (req, res, next) to framework roles", () => {
    // The full guard-chain handler has 4 transitions; use that to pick it
    // unambiguously without depending on source order.
    const main = summaries.find((s) => s.transitions.length === 4);
    expect(main).toBeDefined();
    const roles = main?.inputs
      .filter((i) => i.type === "parameter")
      .map((i) => (i.type === "parameter" ? i.role : null));
    expect(roles).toEqual(["request", "response", "next"]);
  });

  it("assembles the /users/:id guard chain into four response transitions", () => {
    const main = summaries.find((s) => s.transitions.length === 4);
    expect(main).toBeDefined();

    // Branch order:
    //   1. !id                       → res.status(400).json(...)   → 400
    //   2. !user                     → res.status(404).json(...)   → 404
    //   3. user.role === "admin"     → res.json(...)               → 200 (default)
    //   4. default                   → res.json(user)              → 200 (default)
    const statusCodes = main?.transitions.map((t) =>
      t.output.type === "response" ? t.output.statusCode : "not-response",
    );
    expect(statusCodes).toEqual([
      { type: "literal", value: 400 },
      { type: "literal", value: 404 },
      { type: "literal", value: 200 },
      { type: "literal", value: 200 },
    ]);

    // Only the last transition is implicit default.
    expect(main?.transitions.map((t) => t.isDefault)).toEqual([
      false,
      false,
      false,
      true,
    ]);

    // All four outputs are responses (no throws, no render in this fixture).
    if (!main) {
      throw new Error("main summary missing");
    }
    for (const t of main.transitions) {
      expect(t.output.type).toBe("response");
    }
  });

  it("redirect(url) → 1-arg form falls back to default 302", () => {
    // The 1-arg redirect can't extract status from args (minArgs: 2 guard),
    // so it falls back to the pack's defaultStatusCode: 302.
    // Three single-transition handlers: the two redirects and the
    // webhook catch-all.
    const singleTxn = summaries.filter((s) => s.transitions.length === 1);
    expect(singleTxn).toHaveLength(3);

    const oneArg = singleTxn.find((s) => {
      const out = s.transitions[0].output;
      return (
        out.type === "response" &&
        out.statusCode?.type === "literal" &&
        out.statusCode.value === 302
      );
    });
    expect(oneArg).toBeDefined();
  });

  it("redirect(N, url) → 2-arg form extracts the status code from arg 0", () => {
    const twoArg = summaries
      .filter((s) => s.transitions.length === 1)
      .find((s) => {
        const out = s.transitions[0].output;
        return (
          out.type === "response" &&
          out.statusCode?.type === "literal" &&
          out.statusCode.value === 301
        );
      });
    expect(twoArg).toBeDefined();
  });

  it("has no unhandled-case gaps when there is no contract", () => {
    for (const s of summaries) {
      expect(s.gaps.filter((g) => g.type === "unhandledCase")).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// Mount prefix composition, the aws-alb fixture's orders-app
// ---------------------------------------------------------------------------

describe("expressFramework, mount prefix composition (aws-alb fixture)", () => {
  it("gives a route declared on a mounted router its full path", async () => {
    const ordersAppDir = path.resolve(
      __dirname,
      "../../../../fixtures/aws-alb/src/orders-app",
    );
    const project = createFixtureProject(ordersAppDir, "**/*.ts");

    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [expressFramework()],
    });
    const summaries = await adapter.extractAll();

    const paths = summaries
      .map((s) => s.identity.boundaryBinding?.semantics)
      .filter(
        (sem): sem is Extract<typeof sem, { name: "rest" }> =>
          sem?.name === "rest",
      )
      .map((sem) => `${sem.method} ${sem.path}`)
      .sort();

    // ordersRouter's own /_health gets the app.use("/api/orders", ...) prefix
    // it was mounted under. app.all keeps its own wildcard path, since nothing
    // mounts app itself.
    expect(paths).toEqual(["* /api/orders/*", "GET /api/orders/_health"]);
  });
});
