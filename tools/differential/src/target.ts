// target.ts — the pack-specific surface of the differential harness.
//
// The DSL, the interpreter, and the adjudicator are IR-generic; what
// varies per framework pack is concrete syntax (how a terminal is
// spelled, how a handler is registered) and the response stub the vm
// needs. A `FuzzTarget` bundles exactly that variation, so pointing
// the fuzzer at another HTTP pack is: one renderer, one stub, one
// pack import. See docs/internal/differential-fuzzing.md for the
// extension checklist (including the JSX/render-boundary design).

import expressFramework from "@suss/framework-express";
import { fastifyFramework } from "@suss/framework-fastify";

import type { PatternPack } from "@suss/extractor";
import type { ObservedResponse } from "./execute.js";
import type { Terminal } from "./program.js";

export interface FuzzTarget {
  name: string;
  pack: () => PatternPack;
  /** Render one terminal as a statement (no trailing semicolon). */
  renderTerminal: (terminal: Terminal) => string;
  /** Wrap rendered body lines in the pack's registration form. */
  renderModule: (bodyLines: string[]) => string;
  /** The response stub the vm hands to the handler as its 2nd param. */
  makeResponder: (record: (observed: ObservedResponse) => void) => object;
}

const indent = (lines: string[], by: string): string =>
  lines.map((line) => `${by}${line}`).join("\n");

export const EXPRESS_TARGET: FuzzTarget = {
  name: "express",
  pack: expressFramework,
  renderTerminal: (terminal) => {
    const body = `{ ${terminal.key}: ${JSON.stringify(terminal.value)} }`;
    return terminal.status === null
      ? `res.json(${body})`
      : `res.status(${terminal.status}).json(${body})`;
  },
  renderModule: (bodyLines) =>
    [
      'import { Router } from "express";',
      "",
      "const router = Router();",
      "",
      'router.get("/generated", (req, res) => {',
      indent(bodyLines, "    "),
      "});",
      "",
      "export default router;",
      "",
    ].join("\n"),
  makeResponder: (record) => {
    let currentStatus = 200;
    const res = {
      status: (code: number) => {
        currentStatus = code;
        return res;
      },
      json: (body: unknown) => {
        record({ status: currentStatus, body });
        return res;
      },
      send: (body: unknown) => {
        record({ status: currentStatus, body });
        return res;
      },
      sendStatus: (code: number) => {
        record({ status: code, body: undefined });
        return res;
      },
    };
    return res;
  },
};

export const FASTIFY_TARGET: FuzzTarget = {
  name: "fastify",
  pack: fastifyFramework,
  renderTerminal: (terminal) => {
    const body = `{ ${terminal.key}: ${JSON.stringify(terminal.value)} }`;
    return terminal.status === null
      ? `res.send(${body})`
      : `res.code(${terminal.status}).send(${body})`;
  },
  // The generated handler still names its params (req, res) — parameter
  // names are user-chosen in real code, and keeping them stable lets
  // the DSL's conditions (`req.query.q`) and the interpreter's env key
  // (`req`) stay target-independent.
  renderModule: (bodyLines) =>
    [
      'import Fastify from "fastify";',
      "",
      "const app = Fastify();",
      "",
      'app.get("/generated", (req, res) => {',
      indent(bodyLines, "    "),
      "});",
      "",
      "export default app;",
      "",
    ].join("\n"),
  makeResponder: (record) => {
    let currentStatus = 200;
    const reply = {
      code: (code: number) => {
        currentStatus = code;
        return reply;
      },
      status: (code: number) => {
        currentStatus = code;
        return reply;
      },
      send: (body: unknown) => {
        record({ status: currentStatus, body });
        return reply;
      },
    };
    return reply;
  },
};

export const ALL_TARGETS: FuzzTarget[] = [EXPRESS_TARGET, FASTIFY_TARGET];
