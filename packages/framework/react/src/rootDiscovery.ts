/**
 * Finds the component an app boots with, from calls such as
 * `createRoot(el).render(<App />)`. That component is often exported by
 * nothing, so the export walk misses it. The closure follows its JSX
 * references from here, which makes the rest of the app reachable.
 *
 * Every call in the file is read, the ones inside functions too, since
 * most apps boot inside a function they call once the page is ready.
 * Each call is asked what made it or its receiver, over the store's
 * facts, so a root kept in a variable and a boot call read off the
 * default import both count. The README lists the spellings.
 */

import { Node } from "ts-morph";

import {
  callOpsFor,
  factSourceFor,
  statedFactKey,
} from "@suss/adapter-typescript";
import { anyOf, constructedFrom, imported } from "@suss/recognize";
import { factCallOps } from "@suss/recognize/ops";

import type { TsDiscoveryContext } from "@suss/adapter-typescript";
import type {
  AstCapableValueOps,
  CallOps,
  DiscoveredCustomUnit,
  PatternPack,
  ReceiverOrigin,
} from "@suss/extractor";
import type { CallExpression, NewExpression, SourceFile } from "ts-morph";

const DOM = ["react-dom/client", "react-dom"];

/** One way an app hands React its root element: what makes the call, and where it passes the element. */
interface BootCall {
  readonly start: ReceiverOrigin;
  /** The method called on what `start` made, or unset when the call is the start itself. */
  readonly method?: string;
  readonly at: number;
}

/**
 * `createRoot(el).render(<App />)` and `ReactDOM.render(<App />, el)`,
 * `hydrateRoot(document, <App />)`, React 17's `ReactDOM.hydrate`, and
 * `render` or `hydrate` imported from react-dom by name.
 */
const BOOT_CALLS: readonly BootCall[] = [
  {
    start: anyOf(
      constructedFrom({ from: DOM, named: ["createRoot", "hydrateRoot"] }),
      imported({ from: DOM, named: ["default", "*"] }),
    ),
    method: "render",
    at: 0,
  },
  { start: constructedFrom({ from: DOM, named: ["hydrateRoot"] }), at: 1 },
  {
    start: imported({ from: ["react-dom"], named: ["default", "*"] }),
    method: "hydrate",
    at: 0,
  },
  {
    start: constructedFrom({
      from: ["react-dom"],
      named: ["render", "hydrate"],
    }),
    at: 0,
  },
];

export const reactRootComponents: NonNullable<PatternPack["discoverUnits"]> = (
  sourceFile,
  ctx,
) => {
  const sf = sourceFile as SourceFile;
  // A file that never writes a react-dom module makes no boot call, and
  // reading its calls would state facts for every one of them.
  const text = sf.getFullText();
  if (!DOM.some((module) => text.includes(module))) {
    return [];
  }
  const calls = callsIn(sf, (ctx as TsDiscoveryContext).resolution);
  return BOOT_CALLS.flatMap((boot) =>
    calls.flatMap((call) => rootBooted(call, boot)),
  );
};

/** Every call the file writes, in source order, as the ops over the store's facts. */
function callsIn(
  sf: SourceFile,
  store: TsDiscoveryContext["resolution"],
): CallOps[] {
  const originatesFrom = (value: Node, module: string): boolean =>
    store.originatesFrom(value, module);
  const source = factSourceFor(store, originatesFrom);
  const written: (CallExpression | NewExpression)[] = [];
  sf.forEachDescendant((node) => {
    if (Node.isCallExpression(node) || Node.isNewExpression(node)) {
      written.push(node);
    }
  });
  return written.map(
    (call) =>
      factCallOps(statedFactKey(call, store), source) ??
      callOpsFor(call, { resolution: store, originatesFrom }),
  );
}

/** The component a boot call renders, named by its tag as written. */
function rootBooted(call: CallOps, boot: BootCall): DiscoveredCustomUnit[] {
  if (!boots(call, boot)) {
    return [];
  }
  const tag = call.valueAt(boot.at)?.tag?.() ?? null;
  const found = tag?.function?.() ?? null;
  const func = (found as Partial<AstCapableValueOps> | null)?.ast?.() ?? null;
  return tag === null || func === null
    ? []
    : [{ func, kind: "component", name: tag.source?.() ?? "" }];
}

function boots(call: CallOps, boot: BootCall): boolean {
  if (boot.method === undefined) {
    return call.isFrom(boot.start);
  }
  return call.method() === boot.method && call.receiverIsFrom(boot.start);
}
