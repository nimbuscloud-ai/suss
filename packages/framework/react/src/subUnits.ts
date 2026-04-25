// sub-units.ts — React sub-unit synthesis.
//
// A React component's render body is the parent DiscoveredUnit. This
// module produces the child units the React runtime schedules on its
// behalf:
//
//   - One `handler`-kind unit per JSX event-handler prop (`onClick`,
//     `onChange`, …) that resolves to a locally-authored function.
//     Prop-delegating references (`onClick={props.onDelete}`) are
//     skipped — those invoke an external handler we don't own.
//
//   - One `handler`-kind unit per `useEffect(fn, deps?)` call inside
//     the component body, with `metadata.react.kind = "effect"` and
//     the deps-array source text captured for provenance.
//
// Both patterns instantiate the general "runtime schedules a callback
// in response to an event" concept (`docs/roadmap-react.md`, decisions
// #35 and #36): the render body is the parent synchronization concept;
// handlers and effects are synchronized actions triggered by distinct
// runtime events (user interaction, state change / mount / unmount).
// The adapter's `subUnits` hook is what makes N-per-component
// discovery work without the pack needing its own top-level scanner.

import type { FunctionRoot, TsSubUnitContext } from "@suss/adapter-typescript";
import type {
  DiscoveredSubUnit,
  DiscoveredSubUnitParent,
  InputMappingPattern,
} from "@suss/extractor";

const EVENT_HANDLER_INPUT: InputMappingPattern = {
  type: "positionalParams",
  params: [{ position: 0, role: "event" }],
};

const USE_EFFECT_INPUT: InputMappingPattern = {
  type: "positionalParams",
  params: [],
};

/**
 * Main entry point: produce every sub-unit the React pack can see
 * inside a component body.
 */
export function reactSubUnits(
  parent: DiscoveredSubUnitParent,
  ctx: unknown,
): DiscoveredSubUnit[] {
  // The extractor signatures declare `ctx: unknown` so no framework
  // pack's code is leaked into the generic interface. React's pack
  // is written against the TypeScript adapter — cast here, and the
  // cast is the "I require the TS adapter" contract. Packs paired
  // with other adapters would perform their own equivalent narrowing.
  const tsCtx = ctx as TsSubUnitContext;
  const parentFunc = parent.func as FunctionRoot;

  return [
    ...synthesizeEventHandlers(parent.name, parentFunc, tsCtx),
    ...synthesizeUseEffects(parent.name, parentFunc, tsCtx),
  ];
}

// ---------------------------------------------------------------------------
// JSX event handlers
// ---------------------------------------------------------------------------

/**
 * A JSX prop counts as an event handler when its name starts with "on"
 * followed by an uppercase letter — `onClick`, `onChange`, `onSubmit`,
 * and user-authored callback props like `onDelete`. This matches the
 * React convention without hardcoding a list of DOM event names.
 */
function isEventHandlerPropName(name: string): boolean {
  if (name.length < 3) {
    return false;
  }
  if (name[0] !== "o" || name[1] !== "n") {
    return false;
  }
  const third = name[2];
  return third === third.toUpperCase() && third !== third.toLowerCase();
}

interface HandlerRaw {
  func: FunctionRoot;
  tag: string;
  propName: string;
  localName: string | null;
}

function synthesizeEventHandlers(
  componentName: string,
  parentFunc: FunctionRoot,
  ctx: TsSubUnitContext,
): DiscoveredSubUnit[] {
  const raw: HandlerRaw[] = [];

  for (const attr of ctx.findJsxAttributes(parentFunc)) {
    if (!isEventHandlerPropName(attr.name)) {
      continue;
    }
    const resolved = ctx.resolveAttributeValueFunction(attr, parentFunc);
    if (resolved === null) {
      // Prop delegation, external reference, or boolean-shorthand
      // attribute — nothing to extract.
      continue;
    }
    raw.push({
      func: resolved.func,
      tag: attr.tag,
      propName: attr.name,
      localName: resolved.localName,
    });
  }

  return disambiguateHandlers(raw, componentName);
}

/**
 * Assign stable summary names. Named local declarations become
 * `Component.fnName` (legible, matches developer intent). Anonymous
 * inline arrows become `Component.tag.propName`, with `#N` suffixes
 * when the same (tag, propName) key has more than one anonymous
 * handler. Named handlers can't collide because TypeScript won't let
 * two variables in the same scope share a name.
 */
function disambiguateHandlers(
  raw: HandlerRaw[],
  componentName: string,
): DiscoveredSubUnit[] {
  const anonCounts = new Map<string, number>();
  for (const m of raw) {
    if (m.localName !== null) {
      continue;
    }
    const key = `${m.tag}.${m.propName}`;
    anonCounts.set(key, (anonCounts.get(key) ?? 0) + 1);
  }

  const anonSeen = new Map<string, number>();
  return raw.map((m): DiscoveredSubUnit => {
    const name = handlerUnitName(m, componentName, anonCounts, anonSeen);
    return {
      func: m.func,
      kind: "handler",
      name,
      inputMapping: EVENT_HANDLER_INPUT,
      metadata: {
        react: {
          kind: "handler",
          component: componentName,
          elementTag: m.tag,
          propName: m.propName,
          ...(m.localName !== null ? { localName: m.localName } : {}),
        },
      },
    };
  });
}

/**
 * Produce the stable summary name for one handler entry. Named local
 * handlers become `Component.fnName`; anonymous handlers become
 * `Component.tag.propName` with `#N` suffixed when the (tag, propName)
 * key has more than one. Mutates `anonSeen` to advance the per-key
 * counter — kept adjacent to the map's creation site at the caller.
 */
function handlerUnitName(
  m: HandlerRaw,
  componentName: string,
  anonCounts: Map<string, number>,
  anonSeen: Map<string, number>,
): string {
  if (m.localName !== null) {
    return `${componentName}.${m.localName}`;
  }
  const key = `${m.tag}.${m.propName}`;
  const total = anonCounts.get(key) ?? 1;
  if (total <= 1) {
    return `${componentName}.${m.tag}.${m.propName}`;
  }
  const idx = anonSeen.get(key) ?? 0;
  anonSeen.set(key, idx + 1);
  return `${componentName}.${m.tag}.${m.propName}#${idx}`;
}

// ---------------------------------------------------------------------------
// useEffect bodies
// ---------------------------------------------------------------------------

function synthesizeUseEffects(
  componentName: string,
  parentFunc: FunctionRoot,
  ctx: TsSubUnitContext,
): DiscoveredSubUnit[] {
  const out: DiscoveredSubUnit[] = [];
  let index = 0;

  for (const call of ctx.findCallExpressionsByName(parentFunc, "useEffect")) {
    const body = ctx.getCallArgumentFunction(call, 0);
    if (body === null) {
      // Callback is an identifier reference or a non-function value;
      // we can't extract a body, skip rather than fabricate a summary.
      continue;
    }
    const depsArg = ctx.getCallArgument(call, 1);
    const deps = ctx.readArrayLiteralText(depsArg);

    out.push({
      func: body,
      kind: "handler",
      name: `${componentName}.effect#${index}`,
      inputMapping: USE_EFFECT_INPUT,
      metadata: {
        react: {
          kind: "effect",
          component: componentName,
          index,
          // `null` deps means the second argument was absent
          // (re-runs every render); `[]` means mount-only.
          deps,
        },
      },
    });
    index += 1;
  }

  return out;
}
