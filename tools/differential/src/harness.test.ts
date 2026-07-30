import { describe, expect, it } from "vitest";

import { renderProgram } from "./differential.js";
import { executeHandler } from "./execute.js";
import { requestBattery } from "./requests.js";
import { EXPRESS_TARGET, FASTIFY_TARGET } from "./target.js";

import type { HandlerProgram } from "./program.js";

const guardProgram: HandlerProgram = {
  guards: [
    {
      type: "guard",
      cond: {
        type: "truthy",
        field: { source: "query", key: "q" },
        negated: true,
      },
      terminal: { status: 400, key: "error", value: "no" },
    },
  ],
  final: {
    type: "respond",
    terminal: { status: null, key: "ok", value: "yes" },
  },
};

const emptyRequest = { params: {}, query: {}, headers: {}, body: {} };

describe("renderers", () => {
  it("renders the same body into both the module and the handler views", () => {
    const { moduleSource, handlerSource } = renderProgram(
      guardProgram,
      EXPRESS_TARGET,
    );
    expect(moduleSource).toContain("if (!req.query.q) {");
    expect(moduleSource).toContain('res.status(400).json({ error: "no" });');
    expect(handlerSource).toContain("if (!req.query.q) {");
    expect(handlerSource).toContain('res.json({ ok: "yes" });');
  });

  it("renders the same program in the target's terminal syntax", () => {
    const { moduleSource } = renderProgram(guardProgram, FASTIFY_TARGET);
    expect(moduleSource).toContain('import Fastify from "fastify";');
    expect(moduleSource).toContain('res.code(400).send({ error: "no" });');
    expect(moduleSource).toContain('res.send({ ok: "yes" });');
  });
});

describe("executeHandler", () => {
  const run = (request: typeof emptyRequest) =>
    executeHandler(
      renderProgram(guardProgram, EXPRESS_TARGET).handlerSource,
      request,
      EXPRESS_TARGET.makeResponder,
    );

  it("takes the guard when the field is missing", () => {
    expect(run(emptyRequest)).toEqual({
      type: "ok",
      observed: { status: 400, body: { error: "no" } },
    });
  });

  it("falls through to the implicit-200 response when the guard passes", () => {
    expect(run({ ...emptyRequest, query: { q: "x" } })).toEqual({
      type: "ok",
      observed: { status: 200, body: { ok: "yes" } },
    });
  });

  it("executes the fastify rendering with the fastify stub identically", () => {
    const { handlerSource } = renderProgram(guardProgram, FASTIFY_TARGET);
    const result = executeHandler(
      handlerSource,
      emptyRequest,
      FASTIFY_TARGET.makeResponder,
    );
    expect(result).toEqual({
      type: "ok",
      observed: { status: 400, body: { error: "no" } },
    });
  });

  it("reports a handler that never responds as a harness error", () => {
    const result = executeHandler(
      "(req, res) => {}",
      emptyRequest,
      EXPRESS_TARGET.makeResponder,
    );
    expect(result.type).toBe("error");
  });

  it("reports a double response as a harness error", () => {
    const result = executeHandler(
      "(req, res) => { res.json({ a: 1 }); res.json({ b: 2 }); }",
      emptyRequest,
      EXPRESS_TARGET.makeResponder,
    );
    expect(result.type).toBe("error");
  });

  it("reports a runaway loop as a harness error instead of hanging", () => {
    const result = executeHandler(
      "(req, res) => { for (;;) {} }",
      emptyRequest,
      EXPRESS_TARGET.makeResponder,
    );
    expect(result.type).toBe("error");
  });
});

describe("requestBattery", () => {
  it("covers absent, falsy-present, and truthy values for observed fields", () => {
    const battery = requestBattery(guardProgram);
    const qValues = battery.map((request) =>
      Object.hasOwn(request.query, "q") ? request.query.q : "<absent>",
    );
    expect(new Set(qValues)).toEqual(new Set(["<absent>", "", "a"]));
  });

  it("includes literals the program compares against", () => {
    const program: HandlerProgram = {
      guards: [
        {
          type: "guard",
          cond: {
            type: "eq",
            field: { source: "headers", key: "authorization" },
            value: "admin",
            negated: false,
          },
          terminal: { status: 403, key: "error", value: "no" },
        },
      ],
      final: {
        type: "respond",
        terminal: { status: null, key: "ok", value: "yes" },
      },
    };
    const battery = requestBattery(program);
    expect(
      battery.some((request) => request.headers.authorization === "admin"),
    ).toBe(true);
  });

  it("is deterministic for a given program", () => {
    expect(requestBattery(guardProgram)).toEqual(requestBattery(guardProgram));
  });
});
