/**
 * Links a component to the function its TanStack Query hook runs, so the
 * HTTP call inside `queryFn` is tied to the component. An inline function
 * becomes a sub-unit for the client packs to read, and a named one is
 * recorded by identifier for the walk to follow. The README lists the
 * hooks and what is left out.
 */

import { Node } from "ts-morph";

import { callsInUnitBody, importBindsName } from "@suss/adapter-typescript";
import { functionCallBinding } from "@suss/behavioral-ir";

import type {
  ResolutionStore,
  TsInvocationRecognizerContext,
  TsSubUnitContext,
} from "@suss/adapter-typescript";
import type { Effect } from "@suss/behavioral-ir";
import type {
  DiscoveredSubUnit,
  DiscoveredSubUnitParent,
  InvocationRecognizer,
  PatternPack,
} from "@suss/extractor";
import type { PackDeclaration } from "@suss/ir-core";
import type { CallExpression } from "ts-morph";

const QUERY_MODULES = ["@tanstack/react-query", "react-query"];

const HOOK_CALLBACK_PROPERTY: Record<string, string> = {
  useQuery: "queryFn",
  useSuspenseQuery: "queryFn",
  useInfiniteQuery: "queryFn",
  useSuspenseInfiniteQuery: "queryFn",
  useMutation: "mutationFn",
};

/**
 * The library hook a call goes to, with the name the file calls it by.
 * The store follows the import, so an alias and a hook a project file
 * re-exports both count, and a local function that shares a hook's name
 * does not. Only a name an import binds is asked about, since each
 * question costs a derivation and most calls go somewhere else.
 */
function hookOf(
  call: CallExpression,
  resolution: ResolutionStore | undefined,
): { local: string; hook: string } | null {
  const callee = call.getExpression();
  if (resolution === undefined || !Node.isIdentifier(callee)) {
    return null;
  }
  const local = callee.getText();
  if (!importBindsName(call.getSourceFile(), local)) {
    return null;
  }
  const hooks = new Set(
    resolution
      .importOriginsOf(callee, QUERY_MODULES)
      .flatMap(({ path }) => (path.length === 1 ? path : []))
      .filter((name) => Object.hasOwn(HOOK_CALLBACK_PROPERTY, name)),
  );
  const [hook] = hooks;
  return hooks.size === 1 && hook !== undefined ? { local, hook } : null;
}

/**
 * The function the hook runs, from the `queryFn` or `mutationFn` property
 * of an options object, or from the positional argument the v3 API takes
 * (`useQuery(key, fn)`, `useMutation(fn)`). A property written as a
 * method, `queryFn() { ... }`, is that function.
 */
function callbackExpressionOf(call: CallExpression, hook: string): Node | null {
  const property = HOOK_CALLBACK_PROPERTY[hook];
  for (const arg of call.getArguments()) {
    if (Node.isObjectLiteralExpression(arg)) {
      const prop = arg.getProperty(property);
      if (prop !== undefined && Node.isPropertyAssignment(prop)) {
        return prop.getInitializer() ?? null;
      }
      if (prop !== undefined && Node.isShorthandPropertyAssignment(prop)) {
        return prop.getNameNode();
      }
      if (prop !== undefined && Node.isMethodDeclaration(prop)) {
        return prop;
      }
      continue;
    }
    if (
      Node.isArrowFunction(arg) ||
      Node.isFunctionExpression(arg) ||
      Node.isIdentifier(arg)
    ) {
      // In the v3 positional form the first argument is the key, except
      // for `useMutation`, which takes the function first.
      if (call.getArguments().indexOf(arg) > 0 || hook === "useMutation") {
        return arg;
      }
    }
  }
  return null;
}

type CallbackRef =
  | { type: "literal" }
  | { type: "identifier"; name: string }
  | { type: "opaque"; reason: string };

/** Whether the hook's function is written at the call, which makes it a sub-unit of its own. */
function isWrittenInPlace(expression: Node): boolean {
  return (
    Node.isArrowFunction(expression) ||
    Node.isFunctionExpression(expression) ||
    Node.isMethodDeclaration(expression)
  );
}

function callbackRefOf(expression: Node | null): CallbackRef {
  if (expression === null) {
    return { type: "opaque", reason: "missing-query-function" };
  }
  if (isWrittenInPlace(expression)) {
    return { type: "literal" };
  }
  if (Node.isIdentifier(expression)) {
    return { type: "identifier", name: expression.getText() };
  }
  return { type: "opaque", reason: "non-literal-query-function" };
}

const queryHookRecognizer: InvocationRecognizer = (call, ctx) => {
  const c = call as CallExpression;
  if (!Node.isCallExpression(c)) {
    return null;
  }
  const found = hookOf(c, (ctx as TsInvocationRecognizerContext).resolution);
  if (found === null) {
    return null;
  }

  const effect: Effect = {
    type: "interaction",
    binding: functionCallBinding({
      transport: "in-process",
      recognition: "react-query",
    }),
    callee: found.local,
    interaction: {
      class: "schedule",
      via: found.local,
      callbackRef: callbackRefOf(callbackExpressionOf(c, found.hook)),
      hasDelay: false,
    },
  };
  return [effect];
};

/** One sub-unit per hook call whose function is written inline. */
function reactQuerySubUnits(
  parent: DiscoveredSubUnitParent,
  ctx: unknown,
): DiscoveredSubUnit[] {
  const out: DiscoveredSubUnit[] = [];
  const counters = new Map<string, number>();
  const { resolution } = ctx as TsSubUnitContext;

  // The calls the hook recognizer sees, so every hook call it records has
  // the sub-unit behind it.
  for (const call of callsInUnitBody(parent.func as Node)) {
    const found = hookOf(call, resolution);
    if (found === null) {
      continue;
    }
    const expression = callbackExpressionOf(call, found.hook);
    if (expression === null || !isWrittenInPlace(expression)) {
      continue;
    }

    const idx = counters.get(found.local) ?? 0;
    counters.set(found.local, idx + 1);
    out.push({
      func: expression,
      kind: "scheduled-callback",
      name: `${parent.name}.${found.local}#${idx}`,
      inputMapping: { type: "positionalParams", params: [] },
    });
  }

  return out;
}

export function reactQueryFramework(): PatternPack {
  return {
    name: "react-query",
    languages: ["typescript"],
    protocol: "in-process",
    discovery: [],
    terminals: [],
    inputMapping: { type: "positionalParams", params: [] },
    requiresImport: QUERY_MODULES,
    invocationRecognizers: [queryHookRecognizer],
    subUnits: reactQuerySubUnits,
  };
}

export const declares: PackDeclaration = {
  kind: "framework",
  package: "@suss/framework-react-query",
  dependencies: [{ ecosystem: "npm", name: "@tanstack/react-query" }],
  reads:
    "TanStack Query hooks. The pack links a component to the query function that its \`useQuery\` or \`useMutation\` call runs.",
};

export default reactQueryFramework;
