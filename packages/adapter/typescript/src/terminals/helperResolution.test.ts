// helperResolution.test.ts — reading a project's own response helper.
//
// The case these cover came from a production service whose handlers all
// returned through a local `json(statusCode, payload)`. The pack assumed
// the opposite argument order, so every route reported its body as the
// status and its status as the body, at high confidence.

import { Project, SyntaxKind } from "ts-morph";
import { describe, expect, it } from "vitest";

import { findTerminals } from "./index.js";

import type { TerminalPattern } from "@suss/extractor";
import type { FunctionRoot } from "../conditions.js";

/** The AWS Lambda pack's envelope declaration, which names no helper. */
const ENVELOPE: TerminalPattern = {
  kind: "response",
  match: { type: "returnShape", requiredProperties: ["statusCode"] },
  extraction: {
    statusCode: { from: "property", name: "statusCode" },
    body: { from: "property", name: "body", unwrapJsonStringify: true },
  },
};

function terminalsFor(
  source: string,
  patterns: TerminalPattern[] = [ENVELOPE],
) {
  const project = new Project({ useInMemoryFileSystem: true });
  const file = project.createSourceFile("handler.ts", source);
  const handler = file
    .getDescendantsOfKind(SyntaxKind.FunctionDeclaration)
    .find((fn) => fn.getName() === "handler") as FunctionRoot | undefined;
  if (handler === undefined) {
    throw new Error("the fixture needs a function named handler");
  }
  return findTerminals(handler, patterns);
}

describe("reading a local response helper", () => {
  it("reads the status from whichever argument the helper puts it in", () => {
    const terminals = terminalsFor(`
      function json(statusCode: number, payload: unknown) {
        return { statusCode, headers: {}, body: JSON.stringify(payload) };
      }
      export function handler() {
        return json(200, { status: "ok" });
      }
    `);

    expect(terminals).toHaveLength(1);
    expect(terminals[0]?.terminal.statusCode).toEqual({
      type: "literal",
      value: 200,
    });
    expect(terminals[0]?.terminal.body?.shape).toEqual({
      type: "record",
      properties: { status: { type: "literal", value: "ok" } },
    });
  });

  it("reads the other argument order from the same declaration", () => {
    const terminals = terminalsFor(`
      function json(payload: unknown, statusCode: number) {
        return { statusCode, body: JSON.stringify(payload) };
      }
      export function handler() {
        return json({ status: "ok" }, 201);
      }
    `);

    expect(terminals[0]?.terminal.statusCode).toEqual({
      type: "literal",
      value: 201,
    });
    expect(terminals[0]?.terminal.body?.shape).toEqual({
      type: "record",
      properties: { status: { type: "literal", value: "ok" } },
    });
  });

  it("does not care what the helper is called", () => {
    const terminals = terminalsFor(`
      function respond(statusCode: number, payload: unknown) {
        return { statusCode, body: JSON.stringify(payload) };
      }
      export function handler() {
        return respond(404, { error: "gone" });
      }
    `);

    expect(terminals[0]?.terminal.statusCode).toEqual({
      type: "literal",
      value: 404,
    });
  });

  it("stands in a parameter's default when the caller omits it", () => {
    const terminals = terminalsFor(`
      function redirect(location: string, cookie?: string, statusCode = 302) {
        return { statusCode, headers: { location }, body: "" };
      }
      export function handler() {
        return redirect("/home", "session=1");
      }
    `);

    expect(terminals[0]?.terminal.statusCode).toEqual({
      type: "literal",
      value: 302,
    });
  });

  it("prefers an explicit argument over the default", () => {
    const terminals = terminalsFor(`
      function redirect(location: string, cookie?: string, statusCode = 302) {
        return { statusCode, headers: { location }, body: "" };
      }
      export function handler() {
        return redirect("/home", "session=1", 303);
      }
    `);

    expect(terminals[0]?.terminal.statusCode).toEqual({
      type: "literal",
      value: 303,
    });
  });

  it("reads an arrow-function helper", () => {
    const terminals = terminalsFor(`
      const json = (statusCode: number, payload: unknown) => ({
        statusCode,
        body: JSON.stringify(payload),
      });
      export function handler() {
        return json(200, { ok: true });
      }
    `);

    expect(terminals[0]?.terminal.statusCode).toEqual({
      type: "literal",
      value: 200,
    });
  });

  it("reads a helper written with an explicit property rather than shorthand", () => {
    const terminals = terminalsFor(`
      function json(code: number, payload: unknown) {
        return { statusCode: code, body: JSON.stringify(payload) };
      }
      export function handler() {
        return json(418, { teapot: true });
      }
    `);

    expect(terminals[0]?.terminal.statusCode).toEqual({
      type: "literal",
      value: 418,
    });
  });

  it("says it does not know when the helper builds several envelopes", () => {
    const terminals = terminalsFor(`
      function json(statusCode: number, payload: unknown) {
        if (statusCode > 399) {
          return { statusCode, body: JSON.stringify({ error: payload }) };
        }
        return { statusCode, body: JSON.stringify(payload) };
      }
      export function handler() {
        return json(200, { status: "ok" });
      }
    `);

    // A guess would be worth less than saying so: two envelopes leave the
    // helper and this version does not model that.
    expect(terminals[0]?.terminal.statusCode).toEqual({
      type: "dynamic",
      sourceText: 'json(200, { status: "ok" })',
    });
  });

  it("leaves a call it cannot follow alone", () => {
    const terminals = terminalsFor(`
      declare function fromLibrary(x: unknown): { statusCode: number };
      export function handler() {
        return fromLibrary({ status: "ok" });
      }
    `);

    // Nothing to read, and no envelope written at the return site, so no
    // terminal rather than an invented one.
    expect(terminals).toEqual([]);
  });

  it("still reads an envelope written at the return site", () => {
    const terminals = terminalsFor(`
      export function handler() {
        return { statusCode: 204, body: "" };
      }
    `);

    expect(terminals[0]?.terminal.statusCode).toEqual({
      type: "literal",
      value: 204,
    });
  });
});

describe("a pack naming a library's function", () => {
  const LIBRARY_JSON: TerminalPattern = {
    kind: "response",
    match: {
      type: "functionCall",
      functionName: "json",
      requiresImport: ["react-router"],
    },
    extraction: {
      body: { from: "argument", position: 0 },
      defaultStatusCode: 200,
    },
  };

  it("matches the name when it came from that library", () => {
    const terminals = terminalsFor(
      `
      import { json } from "react-router";
      export function handler() {
        return json({ user: 1 });
      }
    `,
      [LIBRARY_JSON],
    );

    expect(terminals[0]?.terminal.statusCode).toEqual({
      type: "literal",
      value: 200,
    });
  });

  it("matches a sub-path of the same library", () => {
    const terminals = terminalsFor(
      `
      import { json } from "react-router/server";
      export function handler() {
        return json({ user: 1 });
      }
    `,
      [LIBRARY_JSON],
    );

    expect(terminals).toHaveLength(1);
  });

  it("ignores a same-named function the project wrote itself", () => {
    const terminals = terminalsFor(
      `
      import { json } from "~/http/response";
      export function handler() {
        return json(200, { user: 1 });
      }
    `,
      [LIBRARY_JSON],
    );

    // Reading react-router's argument order into someone else's `json`
    // is how the status and body ended up swapped.
    expect(terminals).toEqual([]);
  });

  it("follows an alias back to the library", () => {
    const terminals = terminalsFor(
      `
      import { json as toJson } from "react-router";
      export function handler() {
        return toJson({ user: 1 });
      }
    `,
      [
        {
          ...LIBRARY_JSON,
          match: {
            type: "functionCall",
            functionName: "toJson",
            requiresImport: ["react-router"],
          },
        },
      ],
    );

    expect(terminals).toHaveLength(1);
  });
});
