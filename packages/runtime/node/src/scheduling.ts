/**
 * Calls to `setImmediate`, `setTimeout`, `setInterval`,
 * `queueMicrotask` and `process.nextTick`.
 *
 * Each call gets a `schedule` interaction effect. When the callback is
 * written inline as a function, it also becomes a `scheduled-callback`
 * sub-unit with a summary of its own. A timer is the runtime's global
 * unless the program binds the name itself, or one imported from Node's
 * `timers` module under any name. The callee and the callback are read
 * through parentheses and casts, since neither changes what runs.
 */

import { type CallExpression, Node } from "ts-morph";

import {
  boundInProgram,
  callsInUnitBody,
  peelValue,
  writesUndefined,
} from "@suss/adapter-typescript";
import { functionCallBinding } from "@suss/behavioral-ir";

import type { Effect } from "@suss/behavioral-ir";
import type {
  DiscoveredSubUnit,
  DiscoveredSubUnitParent,
  InputMappingPattern,
  InvocationRecognizer,
} from "@suss/extractor";

/** What a timer call takes beside its callback. */
interface Timer {
  hasDelayArg: boolean;
}

/** The runtime's timers, by the name the global and Node's `timers` module give each. */
const TIMERS: ReadonlyMap<string, Timer> = new Map([
  ["setImmediate", { hasDelayArg: false }],
  ["setTimeout", { hasDelayArg: true }],
  ["setInterval", { hasDelayArg: true }],
  ["queueMicrotask", { hasDelayArg: false }],
]);

const NEXT_TICK: Timer = { hasDelayArg: false };

/** The module that exports the timers. Its `/promises` entry takes no callback. */
const TIMER_MODULES = ["timers", "node:timers"];

/** A timer call, with its callee as the source writes it. */
interface TimerCall {
  timer: Timer;
  via: string;
}

/**
 * The timer a call goes to, or null. `via` is the callee as written,
 * past any parentheses or cast around it.
 */
function timerCalled(call: CallExpression): TimerCall | null {
  const callee = peelValue(call.getExpression());
  const timer = Node.isIdentifier(callee)
    ? timerNamed(callee)
    : nextTickCalled(callee);
  return timer === null ? null : { timer, via: callee.getText() };
}

/**
 * A timer called by its bare name: the global when the program does not
 * bind the name, and otherwise one the file imported from Node's
 * `timers` module under that name or another.
 */
function timerNamed(callee: Node): Timer | null {
  if (!boundInProgram(callee)) {
    return TIMERS.get(callee.getText()) ?? null;
  }
  const exported = timerImportedAs(callee);
  return exported === null ? null : (TIMERS.get(exported) ?? null);
}

/**
 * The name `timers` exports a callee under, when the file imported it
 * from there. It is read off the import itself, so a call to any other
 * function the file imports asks the store nothing.
 */
function timerImportedAs(callee: Node): string | null {
  for (const declaration of callee.getSymbol()?.getDeclarations() ?? []) {
    if (
      Node.isImportSpecifier(declaration) &&
      TIMER_MODULES.includes(
        declaration.getImportDeclaration().getModuleSpecifierValue(),
      )
    ) {
      return declaration.getName();
    }
  }
  return null;
}

/** `process.nextTick`, read off the global `process`. */
function nextTickCalled(callee: Node): Timer | null {
  if (
    !Node.isPropertyAccessExpression(callee) ||
    callee.getName() !== "nextTick"
  ) {
    return null;
  }
  const root = peelValue(callee.getExpression());
  return Node.isIdentifier(root) && root.getText() === "process"
    ? NEXT_TICK
    : null;
}

type CallbackRef = Extract<
  Extract<Effect, { type: "interaction" }>["interaction"],
  { class: "schedule" }
>["callbackRef"];

/**
 * What the call hands over as its callback. `undefined` hands over no
 * function, and a callback such as `obj.method` or `getHandler()` is not
 * resolved.
 */
function describeCallback(written: Node | undefined): CallbackRef {
  if (written === undefined) {
    return { type: "opaque", reason: "missing-callback-argument" };
  }
  const arg = peelValue(written);
  if (Node.isArrowFunction(arg) || Node.isFunctionExpression(arg)) {
    return { type: "literal" };
  }
  if (Node.isIdentifier(arg) && !writesUndefined(arg)) {
    return { type: "identifier", name: arg.getText() };
  }
  return { type: "opaque", reason: "non-literal-callback" };
}

export const schedulingRecognizer: InvocationRecognizer = (call, _ctx) => {
  const c = call as CallExpression;
  if (!Node.isCallExpression(c)) {
    return null;
  }
  const called = timerCalled(c);
  if (called === null) {
    return null;
  }

  const effect: Effect = {
    type: "interaction",
    binding: functionCallBinding({
      transport: "in-process",
      recognition: "@suss/runtime-node",
    }),
    callee: called.via,
    interaction: {
      class: "schedule",
      via: called.via,
      callbackRef: describeCallback(c.getArguments()[0]),
      hasDelay: called.timer.hasDelayArg && c.getArguments().length >= 2,
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
 *
 * The calls are the ones the recognizer sees, so a timer set inside a
 * `.then` callback gets its sub-unit too. The walk also goes into each
 * callback it claims, so a timer set inside another timer gets one, and
 * the adapter stops the outer callback's summary at it.
 */
export function nodeSchedulingSubUnits(
  parent: DiscoveredSubUnitParent,
  _ctx: unknown,
): DiscoveredSubUnit[] {
  const out: DiscoveredSubUnit[] = [];
  const counters = new Map<string, number>();

  for (const call of callsInUnitBody(parent.func as Node)) {
    const called = timerCalled(call);
    if (called === null) {
      continue;
    }
    const written = call.getArguments()[0];
    const arg = written === undefined ? undefined : peelValue(written);
    if (
      arg === undefined ||
      !(Node.isArrowFunction(arg) || Node.isFunctionExpression(arg))
    ) {
      continue;
    }

    const idx = counters.get(called.via) ?? 0;
    counters.set(called.via, idx + 1);

    out.push({
      func: arg,
      kind: "scheduled-callback",
      // The index keeps two calls to the same timer in one parent apart.
      name: `${parent.name}.${called.via}#${idx}`,
      inputMapping: SCHEDULED_CALLBACK_INPUT,
      metadata: {
        node: {
          schedulingPrimitive: called.via,
        },
      },
    });
  }

  return out;
}
