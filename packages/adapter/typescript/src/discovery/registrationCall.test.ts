import { Project } from "ts-morph";
import { describe, expect, it } from "vitest";

import { discoverRegistrationCalls } from "./registrationCall.js";

import type { BindingExtraction, DiscoveryPattern } from "@suss/extractor";

type RegistrationMatch = Extract<
  DiscoveryPattern["match"],
  { type: "registrationCall" }
>;

function sourceFile(code: string) {
  const project = new Project({ useInMemoryFileSystem: true });
  return project.createSourceFile("test.ts", code);
}

// HTTP-style: method from the registration verb, path from arg 0.
const httpBinding: BindingExtraction = {
  method: { type: "fromRegistration", position: "methodName" },
  path: { type: "fromRegistration", position: 0 },
};

const expressMatch: RegistrationMatch = {
  type: "registrationCall",
  importModule: "express",
  importName: "Router",
  registrationChain: [".get", ".post", ".put"],
};

describe("discoverRegistrationCalls — handler discovery", () => {
  it("finds an express last-arg handler and lifts (method, path) into routeInfo", () => {
    const sf = sourceFile(`
      import { Router } from "express";
      const r = Router();
      r.get("/users/:id", (req, res) => { res.json({}); });
    `);
    const units = discoverRegistrationCalls(
      sf,
      expressMatch,
      "handler",
      httpBinding,
    );
    expect(units).toHaveLength(1);
    expect(units[0].kind).toBe("handler");
    expect(units[0].routeInfo).toEqual({ method: "GET", path: "/users/:id" });
  });

  it("lifts the path from a no-substitution template literal", () => {
    const sf = sourceFile(`
      import { Router } from "express";
      const r = Router();
      r.post(\`/items\`, (req, res) => { res.json({}); });
    `);
    const units = discoverRegistrationCalls(
      sf,
      expressMatch,
      "handler",
      httpBinding,
    );
    expect(units[0].routeInfo).toEqual({ method: "POST", path: "/items" });
  });

  it("omits routeInfo when the path argument isn't a literal", () => {
    const sf = sourceFile(`
      import { Router } from "express";
      const r = Router();
      const p = "/dynamic";
      r.get(p, (req, res) => { res.json({}); });
    `);
    const units = discoverRegistrationCalls(
      sf,
      expressMatch,
      "handler",
      httpBinding,
    );
    expect(units).toHaveLength(1);
    expect(units[0].routeInfo).toBeUndefined();
  });

  it("omits routeInfo when no bindingExtraction is supplied", () => {
    const sf = sourceFile(`
      import { Router } from "express";
      const r = Router();
      r.get("/x", (req, res) => { res.json({}); });
    `);
    const units = discoverRegistrationCalls(sf, expressMatch, "handler");
    expect(units[0].routeInfo).toBeUndefined();
  });

  it("reads the method from a numeric argument position when configured", () => {
    const sf = sourceFile(`
      import { App } from "framework";
      const app = App();
      app.route("PATCH", "/things/:id", (req, res) => {});
    `);
    const match: RegistrationMatch = {
      type: "registrationCall",
      importModule: "framework",
      importName: "App",
      registrationChain: [".route"],
    };
    const binding: BindingExtraction = {
      method: { type: "fromRegistration", position: 0 },
      path: { type: "fromRegistration", position: 1 },
    };
    const units = discoverRegistrationCalls(sf, match, "handler", binding);
    expect(units[0].routeInfo).toEqual({
      method: "PATCH",
      path: "/things/:id",
    });
  });

  it("omits routeInfo when the numeric method argument isn't a literal", () => {
    const sf = sourceFile(`
      import { App } from "framework";
      const app = App();
      const verb = "GET";
      app.route(verb, "/x", (req, res) => {});
    `);
    const match: RegistrationMatch = {
      type: "registrationCall",
      importModule: "framework",
      importName: "App",
      registrationChain: [".route"],
    };
    const binding: BindingExtraction = {
      method: { type: "fromRegistration", position: 0 },
      path: { type: "fromRegistration", position: 1 },
    };
    const units = discoverRegistrationCalls(sf, match, "handler", binding);
    expect(units[0].routeInfo).toBeUndefined();
  });

  it("omits routeInfo when the binding doesn't come from the registration", () => {
    const sf = sourceFile(`
      import { Router } from "express";
      const r = Router();
      r.get("/x", (req, res) => { res.json({}); });
    `);
    const binding: BindingExtraction = {
      method: { type: "fromContract" },
      path: { type: "fromContract" },
    };
    const units = discoverRegistrationCalls(
      sf,
      expressMatch,
      "handler",
      binding,
    );
    expect(units[0].routeInfo).toBeUndefined();
  });

  it("discovers ts-rest object-arg handlers (method shorthand and arrow props), without routeInfo", () => {
    const sf = sourceFile(`
      import { initServer } from "@ts-rest/express";
      const s = initServer();
      export const router = s.router({} as any, {
        async getUser({ params }) { return { status: 200, body: {} }; },
        listUsers: async () => ({ status: 200, body: [] }),
      });
    `);
    const match: RegistrationMatch = {
      type: "registrationCall",
      importModule: "@ts-rest/express",
      importName: "initServer",
      registrationChain: [".router"],
    };
    const units = discoverRegistrationCalls(sf, match, "handler", httpBinding);
    expect(units.map((u) => u.name).sort()).toEqual(["getUser", "listUsers"]);
    for (const u of units) {
      expect(u.routeInfo).toBeUndefined();
    }
  });

  it("resolves the registration variable from a default import", () => {
    const sf = sourceFile(`
      import express from "express";
      const app = express();
      app.get("/", (req, res) => { res.json({}); });
    `);
    const match: RegistrationMatch = {
      type: "registrationCall",
      importModule: "express",
      importName: "express",
      registrationChain: [".get"],
    };
    const units = discoverRegistrationCalls(sf, match, "handler", httpBinding);
    expect(units).toHaveLength(1);
    expect(units[0].routeInfo).toEqual({ method: "GET", path: "/" });
  });

  it("returns nothing when the registration module isn't imported", () => {
    const sf = sourceFile(`
      const r = somethingElse();
      r.get("/x", (req, res) => {});
    `);
    expect(
      discoverRegistrationCalls(sf, expressMatch, "handler", httpBinding),
    ).toEqual([]);
  });

  it("ignores registration-shaped calls on a variable that isn't the routable", () => {
    const sf = sourceFile(`
      import { Router } from "express";
      const r = Router();
      const other = {};
      other.get("/x", (req, res) => {});
    `);
    expect(
      discoverRegistrationCalls(sf, expressMatch, "handler", httpBinding),
    ).toEqual([]);
  });
});
