/**
 * The routes a pack declares as a route table, composed once over every
 * file of the run. FastAPI writes a route as a decorator called on an
 * app or a router, and flask-restx as a decorator on a class, called on
 * an API or a namespace. Either library mounts a router with a call that
 * can be in any file, so no file's routes can be read from that file
 * alone. Discovery asks for the routes each decorator declares, and the
 * wrapper index asks for the mounts above a router.
 *
 * The table gives one outcome for each way a walk from the app reaches a
 * decorator. They fold into one answer per method: the distinct prefixes
 * the route is served under, or why it has no path, where a reason about
 * the route's own router is said before one about a router above it.
 */

import { composeAppRoutes } from "@suss/recognize";

import { rangeOf } from "./ast.js";
import { pythonModuleOps } from "./declaredDiscovery.js";
import { nodeOfResolutionKey } from "./values/evaluator.js";

import type { Database } from "@suss/datalog";
import type {
  CallOps,
  RouteOutcome,
  MountHop as TableHop,
} from "@suss/extractor";
import type { BoundPythonFile } from "./boundFiles.js";
import type {
  PythonDiscoveryPattern,
  PythonPack,
  RootUnreadWords,
  RouterUnreadWords,
} from "./pack.js";
import type { PyNode } from "./parser.js";

/** One mount above a router: the call that mounts it, and the router it mounts it on, null for the app. */
export interface MountHop {
  call: PyNode;
  file: string;
  parentKey: string | null;
}

/**
 * What one decorator declares for one method: the prefixes its route is
 * served under, or why it has no path. `through` is the key of the
 * library call a project wrapper the decorator calls returns, which the
 * route's wrappers are read off.
 */
export type DeclaredRoute = (
  | { kind: "served"; method: string; prefixes: readonly string[] }
  | { kind: "unread"; method: string; reason: string }
) & { through?: string };

export interface DeclaredRouteIndex {
  /** By the key of the decorator's call, what it declares for each method it serves, in the order the table gives them. */
  routesAt(pattern: PythonDiscoveryPattern, decorator: string): DeclaredRoute[];
  /**
   * The mounts above the router built by this call, innermost first, up
   * to the one on the app. Null unless the table reaches the router one
   * way only, since a route reached two ways runs only the wrappers of
   * the way a request took.
   */
  mountsAbove(
    pattern: PythonDiscoveryPattern,
    routerKey: string,
  ): MountHop[] | null;
}

type Unread = Extract<RouteOutcome, { kind: "unread"; handler: unknown }>;
type Walked = Extract<RouteOutcome, { handler: unknown }>;

/** What one pattern's table gave, by decorator and by router. */
interface PatternRoutes {
  readonly byDecorator: ReadonlyMap<string, readonly Walked[]>;
  readonly chains: ReadonlyMap<
    string,
    ReadonlyMap<string, readonly TableHop[]>
  >;
  readonly folded: Map<string, DeclaredRoute[]>;
}

export function buildRouteTables(
  files: readonly BoundPythonFile[],
  packs: readonly PythonPack[],
  facts: Database,
): DeclaredRouteIndex {
  const patterns = packs.flatMap((pack) => pack.discovery);
  const sources =
    patterns.length === 0
      ? []
      : files.map((file) => ({
          module: pythonModuleOps(file, facts),
          displayPath: file.displayPath,
        }));
  const displayPaths = new Map(
    files.map((file) => [file.file, file.displayPath]),
  );
  const byPattern = new Map<PythonDiscoveryPattern, PatternRoutes>();
  for (const pattern of patterns) {
    const set = composeAppRoutes(pattern.routes.table, sources);
    byPattern.set(pattern, indexOutcomes(set.outcomes));
  }
  const sentencesOf = (pattern: PythonDiscoveryPattern): Sentences => ({
    words: pattern.routes.unread,
    displayPathOf: (file) => displayPaths.get(file) ?? file,
    facts,
  });

  return {
    routesAt(pattern, decorator) {
      const routes = byPattern.get(pattern);
      if (routes === undefined) {
        return [];
      }
      const known = routes.folded.get(decorator);
      if (known !== undefined) {
        return known;
      }
      const found = foldedRoutes(
        routes.byDecorator.get(decorator) ?? [],
        sentencesOf(pattern),
      );
      routes.folded.set(decorator, found);
      return found;
    },

    mountsAbove(pattern, routerKey) {
      const chains = byPattern.get(pattern)?.chains.get(routerKey);
      const [only, ...more] = [...(chains?.values() ?? [])];
      return only === undefined || more.length > 0 ? null : hopsOf(only, facts);
    },
  };
}

function indexOutcomes(outcomes: readonly RouteOutcome[]): PatternRoutes {
  const byDecorator = new Map<string, Walked[]>();
  const chains = new Map<string, Map<string, readonly TableHop[]>>();
  for (const outcome of outcomes) {
    if (!("handler" in outcome) || outcome.entry.form !== "call") {
      continue;
    }
    const key = outcome.entry.call.site?.() ?? "";
    const onDecorator = byDecorator.get(key) ?? [];
    onDecorator.push(outcome);
    byDecorator.set(key, onDecorator);

    const mounts = outcome.mounts ?? [];
    const own = mounts[mounts.length - 1]?.value.site?.();
    if (own === undefined || !mountsCompose(outcome)) {
      continue;
    }
    const ways = chains.get(own) ?? new Map<string, readonly TableHop[]>();
    ways.set(
      mounts.map((hop) => hop.call.site?.() ?? "").join("\u0000"),
      mounts,
    );
    chains.set(own, ways);
  }
  return { byDecorator, chains, folded: new Map() };
}

/**
 * Whether every mount on the way to the outcome's router composed, so a
 * wrapper registered on one of them runs for the route: it served, or
 * what stopped it was its own path, its own router's prefix, or a loop
 * that may mount the router in its mount's place.
 */
function mountsCompose(outcome: Walked): boolean {
  if (outcome.kind !== "unread") {
    return true;
  }
  if (outcome.reason === "pathUnread" || outcome.reason === "rivalledMount") {
    return true;
  }
  return outcome.reason === "prefixUnread" && placeOf(outcome) === "own";
}

/** The table's mounts, outermost first, as the wrapper index reads them: innermost first, each with the router it is called on. */
function hopsOf(
  mounts: readonly TableHop[],
  facts: Database,
): MountHop[] | null {
  const hops: MountHop[] = [];
  for (const [at, hop] of mounts.entries()) {
    const call = nodeOfResolutionKey(hop.call.site?.() ?? "", facts);
    if (call === null) {
      return null;
    }
    const parent = at === 0 ? undefined : mounts[at - 1];
    hops.push({
      call,
      file: hop.call.file?.() ?? "",
      parentKey: parent?.value.site?.() ?? null,
    });
  }
  return hops.reverse();
}

interface Sentences {
  readonly words: RouterUnreadWords;
  readonly displayPathOf: (file: string) => string;
  readonly facts: Database;
}

/** One answer per method, in the order the table first gave each. */
function foldedRoutes(
  outcomes: readonly Walked[],
  sentences: Sentences,
): DeclaredRoute[] {
  const byMethod = new Map<string, Walked[]>();
  for (const outcome of outcomes) {
    const method = outcome.method ?? "";
    const list = byMethod.get(method) ?? [];
    list.push(outcome);
    byMethod.set(method, list);
  }
  return [...byMethod].map(([method, found]) =>
    foldedRoute(method, found, sentences),
  );
}

/**
 * A route the table left unread on any way to it has no path, since its
 * served paths could not all be said. A route's own path that did not
 * read is the adapter's to read, so that one is served under its prefix.
 */
function foldedRoute(
  method: string,
  outcomes: readonly Walked[],
  sentences: Sentences,
): DeclaredRoute {
  const made = outcomes[0]?.made?.site?.();
  const through = made === undefined ? {} : { through: made };
  const said = outcomes.flatMap((outcome) =>
    outcome.kind === "unread" && outcome.reason !== "pathUnread"
      ? [reasonOf(outcome, sentences)]
      : [],
  );
  const first = said.find((one) => !one.chain) ?? said[0];
  if (first !== undefined) {
    return { kind: "unread", method, reason: first.text, ...through };
  }
  const prefixes = [
    ...new Set(outcomes.map((outcome) => outcome.prefix ?? "")),
  ];
  return { kind: "served", method, prefixes, ...through };
}

/** Where along the mounts to a route the router an outcome's reason is about is. */
type Place = "own" | "onto" | "above";

/**
 * The route's own router, the one it is mounted onto, or one above that.
 * An outcome no walk reached has no mounts, and the table then says a
 * router other than its own only when it is the one it is mounted onto.
 */
function placeOf(outcome: Unread): Place {
  const mounts = outcome.mounts;
  const own =
    mounts === undefined ? outcome.on : mounts[mounts.length - 1]?.value;
  const router = outcome.router;
  if (router === undefined || sameCall(router, own)) {
    return "own";
  }
  if (
    mounts === undefined ||
    sameCall(router, mounts[mounts.length - 2]?.value)
  ) {
    return "onto";
  }
  return "above";
}

function sameCall(one: CallOps, other: CallOps | undefined): boolean {
  return other !== undefined && one.site?.() === other.site?.();
}

/** What a reason says, and whether it is about a router above the route's own. */
interface Said {
  readonly text: string;
  readonly chain: boolean;
}

/** Each reason, said of the router it is about when that is the route's own, and as a chain of routers otherwise. */
const REASONS: Readonly<
  Record<
    Unread["reason"],
    (outcome: Unread, place: Place, sentences: Sentences) => Said
  >
> = {
  unreached: (outcome, _place, { words }) => unreachedAs(outcome, words),
  unlistedLoop: (outcome, _place, sentences) =>
    own(withLoops(sentences.words.unlistedLoop, outcome, sentences)),
  rivalledMount: (outcome, place, sentences) =>
    place === "own"
      ? own(withLoops(sentences.words.rivalledMount, outcome, sentences))
      : chain(sentences.words),
  mountUnread: (_outcome, place, { words }) =>
    place === "own" ? own(words.mountUnread) : chain(words),
  prefixUnread: (_outcome, place, { words }) => PREFIX_UNREAD[place](words),
  prefixUnstated: (_outcome, place, { words }) =>
    ownWhenSaid(place, words.prefixUnstated, words),
  prefixReplaced: (_outcome, place, { words }) =>
    ownWhenSaid(place, words.prefixReplaced, words),
  cycle: chainOnly,
  pathUnread: chainOnly,
  rootPrefixUnread: rootReason("rootPrefixUnread"),
  carrierSeveral: rootReason("carrierSeveral"),
  carrierUnfollowed: rootReason("carrierUnfollowed"),
  carrierShared: rootReason("carrierShared"),
  carrierPrefixUnread: rootReason("carrierPrefixUnread"),
  carrierRepathed: rootReason("carrierRepathed"),
  carrierNested: rootReason("carrierNested"),
  carrierRegisteredTwice: rootReason("carrierRegisteredTwice"),
};

/** A reason the words say only as a chain of routers: a cycle, and a path of the route's own, which the adapter reads. */
function chainOnly(
  _outcome: Unread,
  _place: Place,
  sentences: Sentences,
): Said {
  return chain(sentences.words);
}

/** A reason about the route's own router, in the words for it when the library has any. */
function ownWhenSaid(
  place: Place,
  text: string | undefined,
  words: RouterUnreadWords,
): Said {
  return place === "own" && text !== undefined ? own(text) : chain(words);
}

/**
 * A reason about the root a route is served from, said of the root for
 * a route declared on it, and of the object a router is mounted on for
 * a route declared on that router.
 */
function rootReason(
  reason: Exclude<keyof RootUnreadWords, "mountedOn">,
): (outcome: Unread, place: Place, sentences: Sentences) => Said {
  return (outcome, _place, { words }) => {
    const root = words.root;
    if (root === undefined) {
      return chain(words);
    }
    return own(
      (outcome.mounts ?? []).length > 0
        ? root.mountedOn.replace("{reason}", root[reason])
        : root[reason],
    );
  };
}

const PREFIX_UNREAD: Readonly<
  Record<Place, (words: RouterUnreadWords) => Said>
> = {
  own: (words) => own(words.prefixUnread),
  onto: (words) => own(words.ontoPrefixUnread),
  above: (words) => chain(words),
};

/** A router no walk reached: on a name assigned two, mounted onto a router no walk reached either, or mounted by nothing. */
function unreachedAs(outcome: Unread, words: RouterUnreadWords): Said {
  if (outcome.shared === true) {
    return own(words.shared);
  }
  return outcome.router === undefined ? own(words.unreached) : chain(words);
}

function reasonOf(outcome: Unread, sentences: Sentences): Said {
  return REASONS[outcome.reason](outcome, placeOf(outcome), sentences);
}

function own(text: string): Said {
  return { text, chain: false };
}

function chain(words: RouterUnreadWords): Said {
  return { text: words.chain, chain: true };
}

/** The words with "a loop at main.py:14 mounts" or "loops at main.py:14, api.py:9 mount" in place of `{loops}`, each loop once, at the line its `for` is written on. */
function withLoops(
  text: string,
  outcome: Unread,
  sentences: Sentences,
): string {
  const locations = [
    ...new Set(
      (outcome.loops ?? []).flatMap((loop) => {
        const at = loopLine(loop, sentences.facts);
        return at === null
          ? []
          : [`${sentences.displayPathOf(loop.file?.() ?? "")}:${at}`];
      }),
    ),
  ].sort();
  const clause =
    locations.length === 1
      ? `a loop at ${locations[0]} mounts`
      : `loops at ${locations.join(", ")} mount`;
  return text.replace("{loops}", clause);
}

/** The line of the `for` statement a mount is written in. */
function loopLine(mount: CallOps, facts: Database): number | null {
  let node = nodeOfResolutionKey(mount.site?.() ?? "", facts);
  while (node !== null && node.type !== "for_statement") {
    node = node.parent;
  }
  return node === null ? null : rangeOf(node).start;
}
