/**
 * React runs a component's event handlers and effect bodies apart from
 * its render body, on their own triggers, so each one becomes a unit of
 * its own under the component (decisions #35 and #36). The adapter's
 * `subUnits` hook calls this once per component, so the pack needs no
 * scanner of its own to find several units per component.
 *
 * The README describes which handlers count and how each unit is named.
 */

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

/** Returns the event-handler and `useEffect` units in one component body. */
export function reactSubUnits(
  parent: DiscoveredSubUnitParent,
  ctx: unknown,
): DiscoveredSubUnit[] {
  // The extractor types `ctx` as `unknown` to keep adapter types out of
  // its interface. This pack runs only with the TypeScript adapter, so
  // the cast is safe.
  const tsCtx = ctx as TsSubUnitContext;
  const parentFunc = parent.func as FunctionRoot;

  return [
    ...synthesizeEventHandlers(parent.name, parentFunc, tsCtx),
    ...synthesizeUseEffects(parent.name, parentFunc, tsCtx),
  ];
}

/**
 * `on` followed by an uppercase letter covers DOM events and callback
 * props such as `onDelete`, with no list of DOM event names to maintain.
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
      // A prop passed through from props, a reference to another module,
      // or a bare boolean attribute has no body in this component.
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
 * Counts the anonymous handlers on each element and prop first, so a name
 * gets a `#N` suffix only when two of them share one. Named handlers
 * cannot collide, because TypeScript does not let two variables in one
 * scope share a name.
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
      // The element and prop are already in the summary name, and nothing
      // reads them from metadata (#462).
      metadata: {
        react: {
          kind: "handler",
          component: componentName,
        },
      },
    };
  });
}

/**
 * `Component.fnName` for a named handler, `Component.tag.propName` for an
 * anonymous one, with `#N` added when more than one anonymous handler is
 * on the same element and prop. Advances the counter in `anonSeen`.
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
      // An identifier or a value that is not a function has no body here
      // to summarize.
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
          // `null` means no deps argument, so the effect runs after every
          // render. `[]` means it runs on mount only.
          deps,
        },
      },
    });
    index += 1;
  }

  return out;
}
