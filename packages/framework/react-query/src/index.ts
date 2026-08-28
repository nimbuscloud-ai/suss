/**
 * @suss/framework-react-query: the PatternPack for TanStack Query
 * (`@tanstack/react-query`, and the v3 `react-query` module).
 *
 * A component calling `useQuery({ queryKey, queryFn })` reaches an API
 * through the query function, and without this pack that reach is
 * invisible: the HTTP call lives in `queryFn` and nothing ties it to
 * the component. The pack recognizes the hook calls and emits a
 * schedule interaction saying which function the hook runs. An inline
 * `queryFn` becomes a sub-unit, so the client packs read the HTTP call
 * inside it; a named one is recorded by identifier for the walk to
 * follow. Components come from the react pack, and a run with only
 * this pack still reports effects through the closure roots.
 */

import { Node } from "ts-morph";

import { importedNamesOf } from "@suss/adapter-typescript";
import { functionCallBinding } from "@suss/behavioral-ir";

import type { Effect } from "@suss/behavioral-ir";
import type {
  DiscoveredSubUnit,
  DiscoveredSubUnitParent,
  InvocationRecognizer,
  PatternPack,
} from "@suss/extractor";
import type { CallExpression, SourceFile } from "ts-morph";

const QUERY_MODULES = ["@tanstack/react-query", "react-query"];

/** Hook name to the options property its function lives under. */
const HOOK_CALLBACK_PROPERTY: Record<string, string> = {
  useQuery: "queryFn",
  useSuspenseQuery: "queryFn",
  useInfiniteQuery: "queryFn",
  useSuspenseInfiniteQuery: "queryFn",
  useMutation: "mutationFn",
};

/** Local spelling to the library hook it imports, aliases included. */
function importedHooksOf(sourceFile: SourceFile): Map<string, string> {
  const hooks = new Map<string, string>();
  for (const [local, canonical] of importedNamesOf(sourceFile, QUERY_MODULES)) {
    if (canonical in HOOK_CALLBACK_PROPERTY) {
      hooks.set(local, canonical);
    }
  }
  return hooks;
}

/** The hook a call reaches: the local name it was called by, and the
 * library name that decides which options property to read. */
function hookOf(call: CallExpression): { local: string; hook: string } | null {
  const callee = call.getExpression();
  if (!Node.isIdentifier(callee)) {
    return null;
  }
  const local = callee.getText();
  const hook = importedHooksOf(call.getSourceFile()).get(local);
  return hook === undefined ? null : { local, hook };
}

/**
 * The function the hook runs: the `queryFn` / `mutationFn` property of
 * an options object, or the positional function the v3 API takes
 * (`useQuery(key, fn)`, `useMutation(fn)`).
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
      continue;
    }
    if (
      Node.isArrowFunction(arg) ||
      Node.isFunctionExpression(arg) ||
      Node.isIdentifier(arg)
    ) {
      // v3 positional form; the first argument is the key, so a bare
      // identifier in position 0 is the key, never the function.
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

function callbackRefOf(expression: Node | null): CallbackRef {
  if (expression === null) {
    return { type: "opaque", reason: "missing-query-function" };
  }
  if (
    Node.isArrowFunction(expression) ||
    Node.isFunctionExpression(expression)
  ) {
    return { type: "literal" };
  }
  if (Node.isIdentifier(expression)) {
    return { type: "identifier", name: expression.getText() };
  }
  return { type: "opaque", reason: "non-literal-query-function" };
}

const queryHookRecognizer: InvocationRecognizer = (call, _ctx) => {
  const c = call as CallExpression;
  if (!Node.isCallExpression(c)) {
    return null;
  }
  const found = hookOf(c);
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
  _ctx: unknown,
): DiscoveredSubUnit[] {
  const parentFunc = parent.func as Node;
  const out: DiscoveredSubUnit[] = [];
  const counters = new Map<string, number>();

  parentFunc.forEachDescendant((node, traversal) => {
    if (
      node !== parentFunc &&
      (Node.isFunctionDeclaration(node) || Node.isMethodDeclaration(node))
    ) {
      traversal.skip();
      return;
    }
    if (!Node.isCallExpression(node)) {
      return;
    }
    const found = hookOf(node);
    if (found === null) {
      return;
    }
    const expression = callbackExpressionOf(node, found.hook);
    if (
      expression === null ||
      !(
        Node.isArrowFunction(expression) ||
        Node.isFunctionExpression(expression)
      )
    ) {
      return;
    }

    const idx = counters.get(found.local) ?? 0;
    counters.set(found.local, idx + 1);
    out.push({
      func: expression,
      kind: "scheduled-callback",
      name: `${parent.name}.${found.local}#${idx}`,
      inputMapping: { type: "positionalParams", params: [] },
    });
  });

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

export default reactQueryFramework;
