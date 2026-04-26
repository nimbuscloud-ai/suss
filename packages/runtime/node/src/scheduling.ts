// scheduling.ts — recognize Node scheduling primitives and emit
// `interaction(class: "schedule")` effects + scheduled-callback sub-units.
//
// Recognized primitives:
//   setImmediate(fn[, ...args])
//   setTimeout(fn, delay[, ...args])
//   setInterval(fn, delay[, ...args])
//   queueMicrotask(fn)
//   process.nextTick(fn[, ...args])
//
// For each call:
//   - The recognizer emits one schedule effect (per the IR's
//     `interaction.class === "schedule"` discriminator).
//   - The subUnits hook synthesizes one `scheduled-callback` sub-unit
//     per call whose first argument resolves to a literal function
//     expression. Identifier and opaque callbacks emit no sub-unit;
//     the recognizer's effect carries an opaque callbackRef instead.

import {
  type CallExpression,
  Node,
  type PropertyAccessExpression,
} from "ts-morph";

import { functionCallBinding } from "@suss/behavioral-ir";

import type { Effect } from "@suss/behavioral-ir";
import type {
  DiscoveredSubUnit,
  DiscoveredSubUnitParent,
  InputMappingPattern,
  InvocationRecognizer,
} from "@suss/extractor";

type ScheduleVia =
  | "setImmediate"
  | "setTimeout"
  | "setInterval"
  | "queueMicrotask"
  | "process.nextTick";

interface SchedulingPrimitive {
  via: ScheduleVia;
  /**
   * Whether the call carries a delay argument. `setTimeout` /
   * `setInterval` do; the others don't. Drives the `hasDelay` field
   * on the emitted effect.
   */
  hasDelayArg: boolean;
  matches: (call: CallExpression) => boolean;
}

const PRIMITIVES: SchedulingPrimitive[] = [
  {
    via: "setImmediate",
    hasDelayArg: false,
    matches: (c) => isBareIdentifierCall(c, "setImmediate"),
  },
  {
    via: "setTimeout",
    hasDelayArg: true,
    matches: (c) => isBareIdentifierCall(c, "setTimeout"),
  },
  {
    via: "setInterval",
    hasDelayArg: true,
    matches: (c) => isBareIdentifierCall(c, "setInterval"),
  },
  {
    via: "queueMicrotask",
    hasDelayArg: false,
    matches: (c) => isBareIdentifierCall(c, "queueMicrotask"),
  },
  {
    via: "process.nextTick",
    hasDelayArg: false,
    matches: (c) => isPropertyAccessCall(c, "process", "nextTick"),
  },
];

function isBareIdentifierCall(call: CallExpression, name: string): boolean {
  const callee = call.getExpression();
  return Node.isIdentifier(callee) && callee.getText() === name;
}

function isPropertyAccessCall(
  call: CallExpression,
  rootName: string,
  propName: string,
): boolean {
  const callee = call.getExpression();
  if (!Node.isPropertyAccessExpression(callee)) {
    return false;
  }
  const pae = callee as PropertyAccessExpression;
  if (pae.getName() !== propName) {
    return false;
  }
  const root = pae.getExpression();
  return Node.isIdentifier(root) && root.getText() === rootName;
}

function recognizePrimitive(call: CallExpression): SchedulingPrimitive | null {
  for (const p of PRIMITIVES) {
    if (p.matches(call)) {
      return p;
    }
  }
  return null;
}

function describeCallback(arg: Node | undefined): {
  type: "literal" | "identifier" | "opaque";
  name?: string;
  reason?: string;
} {
  if (arg === undefined) {
    return { type: "opaque", reason: "missing-callback-argument" };
  }
  if (Node.isArrowFunction(arg) || Node.isFunctionExpression(arg)) {
    return { type: "literal" };
  }
  if (Node.isIdentifier(arg)) {
    return { type: "identifier", name: arg.getText() };
  }
  // Property access (`obj.method`), call expression (`getHandler()`),
  // any non-trivial expression — the analyzer can't resolve the
  // callback without runtime info.
  return { type: "opaque", reason: "non-literal-callback" };
}

// ---------------------------------------------------------------------------
// invocationRecognizer
// ---------------------------------------------------------------------------

export const schedulingRecognizer: InvocationRecognizer = (call, _ctx) => {
  const c = call as CallExpression;
  if (!Node.isCallExpression(c)) {
    return null;
  }
  const primitive = recognizePrimitive(c);
  if (primitive === null) {
    return null;
  }

  const callback = describeCallback(c.getArguments()[0]);
  const callbackRef =
    callback.type === "literal"
      ? ({ type: "literal" } as const)
      : callback.type === "identifier"
        ? ({ type: "identifier", name: callback.name ?? "<unknown>" } as const)
        : ({
            type: "opaque",
            reason: callback.reason ?? "non-literal-callback",
          } as const);

  const effect: Effect = {
    type: "interaction",
    binding: functionCallBinding({
      transport: "in-process",
      recognition: "@suss/runtime-node",
    }),
    callee: c.getExpression().getText(),
    interaction: {
      class: "schedule",
      via: primitive.via,
      callbackRef,
      hasDelay: primitive.hasDelayArg && c.getArguments().length >= 2,
    },
  };

  return [effect];
};

// ---------------------------------------------------------------------------
// subUnits
// ---------------------------------------------------------------------------

const SCHEDULED_CALLBACK_INPUT: InputMappingPattern = {
  type: "positionalParams",
  // Timer callbacks receive whatever `...args` were passed at the
  // schedule site. v0 doesn't track these positions individually —
  // packs that need argument-shape modeling can layer it on top.
  params: [],
};

/**
 * Walk the parent unit's body for scheduling calls whose first
 * argument is an inline function expression, and synthesize one
 * sub-unit per such callback. Identifier-referenced callbacks emit
 * no sub-unit (the recognizer's effect carries the identifier name
 * for inspect rendering instead).
 *
 * Mirrors the contract React's pack uses for `useEffect` bodies.
 */
export function nodeSchedulingSubUnits(
  parent: DiscoveredSubUnitParent,
  _ctx: unknown,
): DiscoveredSubUnit[] {
  const parentFunc = parent.func as Node;
  const out: DiscoveredSubUnit[] = [];
  const counters = new Map<ScheduleVia, number>();

  parentFunc.forEachDescendant((node, traversal) => {
    // Skip nested function bodies — sub-units of nested fns belong
    // to those fns' own summaries.
    if (
      node !== parentFunc &&
      (Node.isFunctionDeclaration(node) ||
        Node.isFunctionExpression(node) ||
        Node.isArrowFunction(node) ||
        Node.isMethodDeclaration(node))
    ) {
      traversal.skip();
      return;
    }
    if (!Node.isCallExpression(node)) {
      return;
    }
    const primitive = recognizePrimitive(node);
    if (primitive === null) {
      return;
    }
    const arg = node.getArguments()[0];
    if (
      arg === undefined ||
      !(Node.isArrowFunction(arg) || Node.isFunctionExpression(arg))
    ) {
      return;
    }

    const idx = counters.get(primitive.via) ?? 0;
    counters.set(primitive.via, idx + 1);

    out.push({
      func: arg,
      kind: "scheduled-callback",
      // Naming convention: `<parent>.<via>#<index>`. Multiple
      // setImmediate calls in the same parent get distinct indices.
      name: `${parent.name}.${primitive.via}#${idx}`,
      inputMapping: SCHEDULED_CALLBACK_INPUT,
      metadata: {
        node: {
          schedulingPrimitive: primitive.via,
        },
      },
    });
  });

  return out;
}
