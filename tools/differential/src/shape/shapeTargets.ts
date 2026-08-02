// shapeTargets.ts: the pack-specific surface of the shape fuzzer.
//
// A shape target is a `FuzzTarget` (pack, terminal syntax, response
// stub) plus the registration form a shape is announced through. The
// dimensions, the oracles, and the minimizer never mention a framework.

import { EXPRESS_TARGET, FASTIFY_TARGET, type FuzzTarget } from "../target.js";
import { ROUTE_PATH, type ShapeSyntax } from "./shapeProgram.js";

export interface ShapeTarget {
  target: FuzzTarget;
  syntax: ShapeSyntax;
}

export const EXPRESS_SHAPE_TARGET: ShapeTarget = {
  target: EXPRESS_TARGET,
  syntax: {
    renderTerminal: EXPRESS_TARGET.renderTerminal,
    preamble: [
      'import { Router } from "express";',
      "",
      "const router = Router();",
    ],
    renderRegistration: (access) =>
      `router.get(${JSON.stringify(ROUTE_PATH)}, ${access});`,
    renderTypedResponse: (expression) => `res.json(${expression})`,
    epilogue: ["export default router;"],
  },
};

export const FASTIFY_SHAPE_TARGET: ShapeTarget = {
  target: FASTIFY_TARGET,
  syntax: {
    renderTerminal: FASTIFY_TARGET.renderTerminal,
    preamble: ['import Fastify from "fastify";', "", "const app = Fastify();"],
    renderRegistration: (access) =>
      `app.get(${JSON.stringify(ROUTE_PATH)}, ${access});`,
    renderTypedResponse: (expression) => `res.send(${expression})`,
    epilogue: ["export default app;"],
  },
};

// A pack whose handler returns its response (Hono, ts-rest) needs one
// more seam here: the shape renderer spells a terminal as a statement,
// and a returned terminal has to be an expression so a concise arrow
// can hold it. Express and Fastify both write to a response object, so
// the two wired targets share one spelling today.
export const ALL_SHAPE_TARGETS: ShapeTarget[] = [
  EXPRESS_SHAPE_TARGET,
  FASTIFY_SHAPE_TARGET,
];
