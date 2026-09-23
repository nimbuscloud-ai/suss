/**
 * Calls to `setImmediate`, `setTimeout`, `setInterval`,
 * `queueMicrotask` and `process.nextTick`.
 *
 * Each call gets a `schedule` interaction effect. When the callback is
 * written inline as a function, it also becomes a `scheduled-callback`
 * sub-unit with a summary of its own. A callback passed by name or
 * computed gets no sub-unit, and the effect's callbackRef records what
 * the call passed.
 */

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
  // A callback such as `obj.method` or `getHandler()` is not resolved.
  return { type: "opaque", reason: "non-literal-callback" };
}

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

const SCHEDULED_CALLBACK_INPUT: InputMappingPattern = {
  type: "positionalParams",
  // A timer callback receives the extra arguments passed to the
  // scheduling call. Those are not mapped to its parameters yet.
  params: [],
};

/**
 * Returns one `scheduled-callback` sub-unit for each scheduling call in
 * the parent whose first argument is an inline function, the way the
 * React pack treats a `useEffect` body. A callback passed by name gets
 * no sub-unit, and the schedule effect records its name instead.
 */
export function nodeSchedulingSubUnits(
  parent: DiscoveredSubUnitParent,
  _ctx: unknown,
): DiscoveredSubUnit[] {
  const parentFunc = parent.func as Node;
  const out: DiscoveredSubUnit[] = [];
  const counters = new Map<ScheduleVia, number>();

  parentFunc.forEachDescendant((node, traversal) => {
    // A scheduling call inside a nested function belongs to that
    // function's own summary.
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
      // The index keeps two calls to the same primitive in one parent
      // apart.
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
