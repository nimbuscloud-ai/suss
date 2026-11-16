/**
 * A route table a library writes, read into the routes each handler
 * serves: Rails' `config/routes.rb`, or React Router's `<Route>` elements
 * and route objects, which route to the component each one renders.
 *
 * A pack states what each entry is called and what it does, as a role: it
 * serves a method at a path, expands to a fixed set of routes, opens a
 * scope, replays a fragment, includes another file, or mounts another
 * table. An entry is a call, a JSX element, or an object in a list.
 * `composeRoutes` walks the entries through the module ops and gives back
 * every route with the entries it could not read. The declaration's types
 * are in `@suss/extractor`, so a discovery pattern can contain a table.
 */

import { bySourceOrder, joinMountedPath } from "@suss/resolution";

import { constructedFrom } from "./ops.js";

import type {
  BaseRole,
  CallOps,
  ChildrenIn,
  DefaultsRole,
  EntryPick,
  EntrySource,
  ExpandsRole,
  ExpansionRow,
  FragmentRole,
  IncludeRole,
  ModuleOps,
  MountHop,
  MountRole,
  PairArg,
  ReceiverUnread,
  ReplayRole,
  RouteGap,
  RouteOutcome,
  RouteRole,
  RouteSet,
  RouteSources,
  RouteTableDeclaration,
  ScopesRole,
  ServesRole,
  TableOwner,
  TableRoute,
  ValueOps,
} from "@suss/extractor";

export type {
  BaseRole,
  ChildrenIn,
  DefaultsRole,
  EntryPick,
  EntrySource,
  ExpandsRole,
  ExpansionRow,
  FragmentRole,
  IncludeRole,
  MountHop,
  MountRole,
  ReceiverUnread,
  ReplayRole,
  RootRule,
  RouteGap,
  RouteOutcome,
  RouteRole,
  RouteSet,
  RouteSources,
  RouteTableDeclaration,
  RouteUnread,
  ScopesRole,
  ServesRole,
  TableOwner,
  TableRoute,
} from "@suss/extractor";

/**
 * An item the walk meets that is no entry, which it reports where it is:
 * a spread or a value in a list of objects, or a list that did not read.
 * `at` is the root call whose own list did not read.
 */
interface UnreadItem {
  readonly form: "unread";
  readonly reason: "spread" | "notAnEntry" | "listUnread" | "rootListUnread";
  readonly value: ValueOps;
  readonly at?: CallOps;
}

/** An entry made on a value, which `ChildrenIn` `receiver` finds by the value its receiver comes to. */
interface ReceiverEntry {
  /** The role's name: the method the entry calls on the value. */
  readonly name: string;
  /** The entry as written, whose arguments the roles read: the call, or the decorator. */
  readonly call: CallOps;
  /** The call made on the value: `call`, or the library call a project wrapper the decorator calls returns. */
  readonly made: CallOps;
  /** The function or class the decorator is written over, for a role whose handler is decorated. */
  readonly decorated: ValueOps | null;
  /** The call that built the value, or null when the receiver comes to no one call. */
  readonly value: CallOps | null;
  /** When the receiver comes to no one call, each call it is written as, such as a name assigned two routers. */
  readonly shared: readonly CallOps[];
}

interface ReceiverItem {
  readonly form: "receiver";
  readonly entry: ReceiverEntry;
}

type Walked = EntrySource | UnreadItem | ReceiverItem;

/**
 * An entry's children, and the list they are the entries of, so a list
 * inside itself stops. For a value's entries, the list is the value, so
 * a mount that leads back into it is a cycle.
 */
interface Children {
  readonly entries: readonly Walked[];
  readonly list: string | null;
}

/** The entries made on each value in the files read, found the first time a table asks for them. */
interface Receivers {
  /** By the site of the call that built the value, in the order the files are read and then the source order. */
  readonly byValue: ReadonlyMap<string, readonly ReceiverEntry[]>;
  /** Each entry whose handler is decorated, so the ones no walk reads are said to be unreached. */
  readonly decorated: readonly ReceiverEntry[];
  /** Each mount written in a loop the table cannot list. */
  readonly unlisted: readonly ReceiverEntry[];
  /** By the site of the call that built a value, each mount entry that mounts it, so a value no walk reaches can say what it is mounted onto. */
  readonly mountedBy: ReadonlyMap<string, readonly ReceiverEntry[]>;
  /** The names each file imports from the table's modules, by its path, so a value built in another file is named the way that file names it. */
  readonly names: ReadonlyMap<string, ReadonlyMap<string, string>>;
}

/** Why an entry whose handler is a value gave no route, with the loops that may mount it and the value the reason is about. */
interface UnreadWhy {
  readonly reason: "pathUnread" | "prefixUnread" | ReceiverUnread;
  readonly loops?: readonly CallOps[];
  readonly router?: CallOps;
  readonly shared?: true;
}

/** Why no path under a scope is claimed: something above it, never the entry itself or its reach. */
interface ScopeUnread extends UnreadWhy {
  readonly reason: Exclude<
    UnreadWhy["reason"],
    "pathUnread" | "unreached" | "unlistedLoop"
  >;
}

/** An expansion the walk is inside, with the bases an entry inside it starts from. */
interface Expansion {
  readonly controllerKey: string;
  readonly collectionBase: string;
  readonly memberBase: string;
  /** Where an expansion nested one level inside goes. */
  readonly nestedBase: string;
  /** Where an entry with no `on` starts: the nested base, or the base a `member` or `collection` block chose. */
  readonly ambientBase: string;
}

interface Scope {
  readonly pathPrefix: string;
  readonly namespace: string;
  readonly expansion?: Expansion;
  /** Keywords a defaults entry gave every entry inside it; an entry's own keyword wins. */
  readonly defaults: Readonly<Record<string, ValueOps>>;
  /** The loop variables an enclosing literal loop binds, each to one element. */
  readonly bindings: ReadonlyMap<string, string>;
  /** Whether a shallow expansion encloses this scope. */
  readonly shallow: boolean;
  /** Where a shallow expansion's member routes start: the mount's prefix and each scope that starts the shallow path. */
  readonly shallowPath: string;
  /** Why no path inside an enclosing entry is claimed, or null while every path above reads. */
  readonly unread: ScopeUnread | null;
  /** The mounts of values the walk went through to get here, outermost first. */
  readonly mounts: readonly MountHop[];
}

/** An entry's arguments, as the picks read them. */
interface EntryArgs {
  readonly positional: readonly ValueOps[];
  readonly keyword: Readonly<Record<string, ValueOps>>;
  /** The last pair whose key is a value rather than a keyword. */
  readonly pair: PairArg | null;
  /** An element's attribute or an object's own property, by name. */
  readonly keyed: (key: string) => ValueOps | undefined;
}

interface Entry {
  readonly source: EntrySource;
  readonly name: string;
  readonly args: EntryArgs;
  /** The function or class a decorator entry is written over. */
  readonly decorated?: ValueOps | null;
  /** For an entry made on a value, the call that built it. */
  readonly on?: CallOps | null;
}

interface Walk {
  readonly table: RouteTableDeclaration;
  readonly sources: RouteSources;
  /** Every keyword a role picks, and so every one a defaults entry can hand down. */
  readonly keywords: readonly string[];
  readonly routes: Map<string, Map<string, TableRoute[]>>;
  readonly gaps: RouteGap[];
  readonly outcomes: RouteOutcome[];
  readonly fragments: Map<string, Children>;
  /** Names an include has read, so a file that includes itself stops. */
  readonly included: Set<string>;
  /** The first root of each mounted table, by the table's name. */
  readonly mounted: Map<string, Root>;
  /** Tables being walked under a mount, so a table that mounts itself stops. */
  readonly mounting: Set<string>;
  /** The lists being walked, outermost first, so a list inside itself stops. */
  readonly opened: string[];
  /** The file a gap is attributed to. */
  file: string;
  /** The names the file being read imports from the table's modules, by the name it uses. */
  names: ReadonlyMap<string, string>;
  /** The entries made on each value, once a `receiver` child asks. */
  receivers: Receivers | null;
  /** The receiver entries a walk has read. */
  readonly read: Set<ReceiverEntry>;
  /** The values whose entries a cycle has walked once with no path, so the cycle stops. */
  readonly cycled: Set<string>;
  /** The sites of the roots left out because their function drops them. */
  readonly dropped: Set<string>;
  /** By site, whether a value a root would mount is kept by its function, once asked. */
  readonly kept: Map<string, boolean>;
}

interface Root {
  readonly kind: string;
  readonly children: Children;
  readonly displayPath: string;
  readonly names: ReadonlyMap<string, string>;
}

const EMPTY_SCOPE: Scope = {
  pathPrefix: "",
  namespace: "",
  defaults: {},
  bindings: new Map(),
  shallow: false,
  shallowPath: "",
  unread: null,
  mounts: [],
};

const NO_KEYS = (): undefined => undefined;

/**
 * Reads the files into the app's route set, for a table whose roots are
 * all the app's and whose entries include no file and inflect no name,
 * as a table whose handlers are values is.
 */
export function composeAppRoutes(
  table: RouteTableDeclaration,
  files: RouteSources["files"],
): RouteSet {
  return composeRoutes(table, {
    files,
    ownerOf: () => ({ table: "app" }),
    include: () => null,
    naming: { singular: (word) => word, plural: (word) => word },
  });
}

/**
 * Reads every root the files write into one route set. The app's roots
 * run in the order their kinds give, then the order the files write them;
 * a mounted table's first root is walked wherever a mount refers to it.
 */
export function composeRoutes(
  table: RouteTableDeclaration,
  sources: RouteSources,
): RouteSet {
  const walk: Walk = {
    table,
    sources,
    keywords: [...keywordsPicked(table.roles, new Set<string>())],
    routes: new Map(),
    gaps: [],
    outcomes: [],
    fragments: new Map(),
    included: new Set(),
    mounted: new Map(),
    mounting: new Set(),
    opened: [],
    file: "",
    names: new Map(),
    receivers: null,
    read: new Set(),
    cycled: new Set(),
    dropped: new Set(),
    kept: new Map(),
  };
  const appRoots: Root[] = [];
  for (const { module, displayPath } of sources.files) {
    const names = namesImported(module, table);
    if (names === null) {
      continue;
    }
    walk.names = names;
    for (const { owner, root } of rootsIn(module, displayPath, walk)) {
      collectRoot(walk, appRoots, sources.ownerOf(owner), root);
    }
    if (table.roots.elements === true) {
      appRoots.push(elementRoot(module, displayPath, names));
    }
  }
  const ordered = appRoots
    .map((root, position) => ({ root, position }))
    .sort(
      (a, b) =>
        (table.roots.kinds[a.root.kind] ?? 0) -
          (table.roots.kinds[b.root.kind] ?? 0) || a.position - b.position,
    );
  for (const { root } of ordered) {
    walk.names = root.names;
    inFile(walk, root.displayPath, () => {
      walkChildren(root.children, EMPTY_SCOPE, walk);
    });
  }
  sayUnreached(walk);
  return {
    routesFor: (controllerKey, action) =>
      walk.routes.get(controllerKey)?.get(action) ?? [],
    gaps: walk.gaps,
    outcomes: walk.outcomes,
  };
}

/**
 * The names the file imports from the table's modules, by the name the
 * file uses, or null when it imports none the table starts from or reads
 * as an entry. A module imported whole gives each name a root or a scope
 * is built by under the module's name, `fastapi.APIRouter` after `import
 * fastapi`. The file's text is asked first, since stating a file's
 * imports to learn it writes none of them costs more than the answer.
 * A table with no modules matches names as written, in every file.
 */
function namesImported(
  module: ModuleOps,
  table: RouteTableDeclaration,
): ReadonlyMap<string, string> | null {
  if (table.from === undefined) {
    return new Map();
  }
  if (!table.from.some((name) => module.mentions(name))) {
    return null;
  }
  const names = new Map(module.importedNames(table.from));
  for (const alias of module.importedWhole?.(table.from) ?? []) {
    for (const name of builtNames(table)) {
      names.set(`${alias}.${name}`, name);
    }
  }
  const read = new Set([
    ...Object.keys(table.roles),
    ...Object.keys(table.roots.kinds),
  ]);
  return [...names.values()].some((name) => read.has(name)) ? names : null;
}

/** The names of the calls a root or a scope is built by, which a walk reads by the call rather than through a receiver. */
function builtNames(table: RouteTableDeclaration): string[] {
  return [
    ...Object.keys(table.roots.kinds),
    ...Object.entries(table.roles)
      .filter(([, role]) => role.role === "scopes")
      .map(([name]) => name),
  ];
}

/** The elements of the file that no element written with children encloses, as one root walked in place. */
function elementRoot(
  module: ModuleOps,
  displayPath: string,
  names: ReadonlyMap<string, string>,
): Root {
  const entries = module
    .elements()
    .map((value): EntrySource => ({ form: "element", value }));
  return { kind: "", children: { entries, list: null }, displayPath, names };
}

function collectRoot(
  walk: Walk,
  appRoots: Root[],
  owner: TableOwner | null,
  root: Root,
): void {
  if (owner === null) {
    return;
  }
  if (owner.table === "app") {
    appRoots.push(root);
    return;
  }
  if (!walk.mounted.has(owner.name)) {
    walk.mounted.set(owner.name, root);
  }
}

/** Every keyword any pick in the roles names. */
function keywordsPicked(value: unknown, into: Set<string>): Set<string> {
  if (typeof value !== "object" || value === null) {
    return into;
  }
  if ("keyword" in value && typeof value.keyword === "string") {
    into.add(value.keyword);
  }
  for (const inner of Object.values(value)) {
    keywordsPicked(inner, into);
  }
  return into;
}

function inFile(walk: Walk, file: string, run: () => void): void {
  const previous = walk.file;
  walk.file = file;
  run();
  walk.file = previous;
}

/**
 * Every root the file writes: among the calls the module body runs, or
 * among the children of a call there, however deep, since a library's
 * hook such as `after_initialize do` can hold one. A table read `in` the
 * whole file lists every call the file writes, inside functions too, so
 * there is nothing more to look inside.
 */
function rootsIn(
  module: ModuleOps,
  displayPath: string,
  walk: Walk,
): { owner: string; root: Root }[] {
  const scope = walk.table.roots.in ?? "moduleBody";
  const found: { owner: string; root: Root }[] = [];
  const visit = (call: CallOps): void => {
    const root = asRoot(call, displayPath, walk);
    if (root !== null) {
      found.push(root);
      return;
    }
    if (scope === "file") {
      return;
    }
    const inner = childrenOf(
      { form: "call", call },
      walk.table.roots.children,
      null,
      walk,
    );
    for (const child of inner?.entries ?? []) {
      if (child.form === "call") {
        visit(child.call);
      }
    }
  };
  for (const call of module.calls(scope)) {
    visit(call);
  }
  return found;
}

function asRoot(
  call: CallOps,
  displayPath: string,
  walk: Walk,
): { owner: string; root: Root } | null {
  const rule = walk.table.roots;
  const kind = callName(call, walk);
  if (
    kind === null ||
    !Object.hasOwn(rule.kinds, kind) ||
    dropped(call, walk)
  ) {
    return null;
  }
  const owner = ownerWritten(call, rule, walk);
  const children =
    owner === null
      ? null
      : childrenOf({ form: "call", call }, rule.children, null, walk);
  if (owner === null || children === null) {
    return null;
  }
  return {
    owner,
    root: {
      kind,
      children: rootListAt(children, call),
      displayPath,
      names: walk.names,
    },
  };
}

/** Whether the root's function drops what it builds, which the walk then leaves out with every entry made on it. */
function dropped(call: CallOps, walk: Walk): boolean {
  const rule = walk.table.roots.unlessDropped;
  if (rule === undefined) {
    return false;
  }
  const owned = new Set([...Object.keys(walk.table.roles), ...rule.owned]);
  if (call.dropped?.(owned) !== true) {
    return false;
  }
  walk.dropped.add(call.site?.() ?? "");
  return true;
}

/** Whether a value a root would mount is dropped by its function the way a root can be, asked once per value. */
function droppedValue(value: CallOps, walk: Walk): boolean {
  const site = value.site?.() ?? "";
  const known = walk.kept.get(site);
  if (known !== undefined) {
    return !known;
  }
  const isDropped = dropped(value, walk);
  walk.kept.set(site, !isDropped);
  return isDropped;
}

/** A root's own list that did not read is said at the root call, where the router is created. */
function rootListAt(children: Children, call: CallOps): Children {
  return {
    ...children,
    entries: children.entries.map(
      (entry): Walked =>
        entry.form === "unread" && entry.reason === "listUnread"
          ? { ...entry, reason: "rootListUnread", at: call }
          : entry,
    ),
  };
}

/**
 * The owner as the source writes it before `.<calledOn>`, such as
 * `Rails.application`, or "" for a root called bare or on a module the
 * file imports whole. Null when the call is not made where the rule says.
 */
function ownerWritten(
  call: CallOps,
  rule: RouteTableDeclaration["roots"],
  walk: Walk,
): string | null {
  if (rule.calledOn === undefined) {
    return hasReceiver(call) && !walk.names.has(call.calleeText()) ? null : "";
  }
  const receiver = call.receiver();
  const suffix = `.${rule.calledOn}`;
  const written = receiver?.calleeText() ?? "";
  if (receiver?.method() !== rule.calledOn || !written.endsWith(suffix)) {
    return null;
  }
  return written.slice(0, -suffix.length);
}

/** The name an entry is matched against the roles by: its method, or the name it calls bare. */
function nameOf(call: CallOps): string {
  return call.method() ?? call.calleeText();
}

/**
 * The name a call is matched against the roots and roles by. Where the
 * table says which modules its names come from, that is the name the
 * module exports, for a call made bare on a name the file imports from
 * one of them or made on a module the file imports whole, and null for
 * any other call.
 */
function callName(call: CallOps, walk: Walk): string | null {
  return callNameIn(call, walk.names, walk.table);
}

function callNameIn(
  call: CallOps,
  names: ReadonlyMap<string, string>,
  table: RouteTableDeclaration,
): string | null {
  if (table.from === undefined) {
    return nameOf(call);
  }
  const written = hasReceiver(call) ? call.calleeText() : nameOf(call);
  return names.get(written) ?? null;
}

/** The name an element is matched against the roles by: its tag, read the way a call's name is. */
function elementName(value: ValueOps, walk: Walk): string | null {
  const written = value.tag?.()?.source?.() ?? null;
  if (written === null || walk.table.from === undefined) {
    return written;
  }
  return walk.names.get(written) ?? null;
}

const ENTRY_NAMES: {
  readonly [F in EntrySource["form"]]: (
    source: Extract<EntrySource, { form: F }>,
    walk: Walk,
  ) => string | null;
} = {
  call: (source, walk) => callName(source.call, walk),
  element: (source, walk) => elementName(source.value, walk),
  object: (_source, walk) => walk.table.objects ?? null,
};

function entryName(source: EntrySource, walk: Walk): string | null {
  const read = ENTRY_NAMES[source.form] as (
    source: EntrySource,
    walk: Walk,
  ) => string | null;
  return read(source, walk);
}

/** Whether the call is written on a receiver, which an entry never is. */
function hasReceiver(call: CallOps): boolean {
  return call.calleeText() !== nameOf(call);
}

/** The call's positional arguments, leaving out a position the call writes nothing readable at. */
function positionalOf(call: CallOps): ValueOps[] {
  const positional: ValueOps[] = [];
  for (let at = 0; at < call.argumentCount(); at++) {
    const value = call.valueAt(at);
    if (value !== null) {
      positional.push(value);
    }
  }
  return positional;
}

/** The entries an entry's children are, or null when it has none where the rule says. */
function childrenOf(
  source: EntrySource,
  rule: ChildrenIn,
  args: EntryArgs | null,
  walk: Walk,
): Children | null {
  const read = CHILDREN_READERS[rule.in] as (
    source: EntrySource,
    rule: ChildrenIn,
    args: EntryArgs | null,
    walk: Walk,
  ) => Children | null;
  return read(source, rule, args, walk);
}

function callsAsChildren(calls: readonly CallOps[]): Children {
  return {
    entries: calls.map((call): EntrySource => ({ form: "call", call })),
    list: null,
  };
}

const CHILDREN_READERS: {
  readonly [K in ChildrenIn["in"]]: (
    source: EntrySource,
    rule: Extract<ChildrenIn, { in: K }>,
    args: EntryArgs | null,
    walk: Walk,
  ) => Children | null;
} = {
  block: (source) => {
    const block =
      source.form === "call" ? (source.call.block?.() ?? null) : null;
    return block === null ? null : callsAsChildren(block.bodyCalls?.() ?? []);
  },
  callback: (source, rule) => {
    const handed =
      source.form === "call" ? positionalOf(source.call)[rule.at] : undefined;
    return handed === undefined
      ? null
      : callsAsChildren(handed.bodyCalls?.() ?? []);
  },
  list: (source, rule, args, walk) => {
    const keywords = "keyword" in rule.pick ? [rule.pick.keyword] : [];
    const list = picked(args ?? argsOf(source, keywords, {}), rule.pick);
    if (list === undefined) {
      return null;
    }
    if (walk.table.objects === undefined) {
      return callsAsChildren(
        list.items().flatMap((item) => item.asCall?.() ?? []),
      );
    }
    return objectsListed(list, walk);
  },
  elements: (source) =>
    source.form === "element"
      ? {
          entries: (source.value.elementsWithin?.() ?? []).map(
            (value): EntrySource => ({ form: "element", value }),
          ),
          list: null,
        }
      : null,
  chain: () => null,
  receiver: (source, _rule, _args, walk) => {
    const value = source.form === "call" ? source.call.site?.() : undefined;
    if (value === undefined) {
      return null;
    }
    const entries = receiversOf(walk).byValue.get(value) ?? [];
    return {
      entries: entries.map((entry): Walked => ({ form: "receiver", entry })),
      list: value,
    };
  },
};

/**
 * The entries a list of objects writes. A spread, or an item written as
 * anything but an object, is unread where it is. A value that is no list
 * is unread where the pick read it, unless it is an element or a call
 * that turns elements into entries, whose elements are read where they
 * are written. A list reached again inside itself stops.
 */
function objectsListed(list: ValueOps, walk: Walk): Children {
  if (list.form?.() === "element" || turnsElementsIntoEntries(list, walk)) {
    return { entries: [], list: null };
  }
  const listed = list.listed?.() ?? null;
  if (listed === null) {
    return {
      entries: [{ form: "unread", reason: "listUnread", value: list }],
      list: null,
    };
  }
  if (walk.opened.includes(listed.key)) {
    return { entries: [], list: null };
  }
  return {
    entries: listed.entries.map(({ form, value }) => listItemOf(form, value)),
    list: listed.key,
  };
}

function listItemOf(form: "value" | "spread", value: ValueOps): Walked {
  if (form === "spread") {
    return { form: "unread", reason: "spread", value };
  }
  return value.form?.() === "object"
    ? { form: "object", value }
    : { form: "unread", reason: "notAnEntry", value };
}

function turnsElementsIntoEntries(value: ValueOps, walk: Walk): boolean {
  const call = value.asCall?.() ?? null;
  const name = call === null ? null : callName(call, walk);
  return name !== null && (walk.table.elementLists ?? []).includes(name);
}

function receiversOf(walk: Walk): Receivers {
  walk.receivers ??= indexReceivers(walk);
  return walk.receivers;
}

/**
 * Every entry made on a value in the files read, by the value its
 * receiver comes to: the decorators of a serves role whose handler is
 * decorated, and the calls of the other serves and mount roles. Each
 * mount written in a loop the table cannot list is kept as well.
 */
function indexReceivers(walk: Walk): Receivers {
  const decoratedRoles = rolesFoundBy("decorator", walk.table);
  const calledRoles = rolesFoundBy("call", walk.table);
  const byValue = new Map<string, ReceiverEntry[]>();
  const decorated: ReceiverEntry[] = [];
  const unlisted: ReceiverEntry[] = [];
  const mountedBy = new Map<string, ReceiverEntry[]>();
  const names = new Map<string, ReadonlyMap<string, string>>();
  for (const { module } of walk.sources.files) {
    const imported = namesImported(module, walk.table);
    if (imported !== null) {
      names.set(module.path(), imported);
    }
    const inFile = [
      ...decoratedEntries(module, decoratedRoles, walk),
      ...calledEntries(module, calledRoles),
    ].sort((a, b) =>
      bySourceOrder(a.call.site?.() ?? "", b.call.site?.() ?? ""),
    );
    for (const entry of inFile) {
      const value = entry.value?.site?.();
      if (value !== undefined) {
        pushTo(byValue, value, entry);
      }
      if (entry.decorated !== null) {
        decorated.push(entry);
      }
      const mounted = valueMounted(entry, walk);
      if (mounted?.kind === "unlisted") {
        unlisted.push(entry);
      }
      for (const call of mounted?.kind === "values" ? mounted.calls : []) {
        pushTo(mountedBy, call.site?.() ?? "", entry);
      }
    }
  }
  return { byValue, decorated, unlisted, mountedBy, names };
}

function pushTo<V>(map: Map<string, V[]>, key: string, value: V): void {
  const list = map.get(key) ?? [];
  list.push(value);
  map.set(key, list);
}

/** The roles whose entries made on a value are found by their decorators, or by their calls. */
function rolesFoundBy(
  found: "decorator" | "call",
  table: RouteTableDeclaration,
): Set<string> {
  return new Set(
    Object.entries(table.roles)
      .filter(([, role]) => foundBy(role) === found)
      .map(([name]) => name),
  );
}

function foundBy(role: RouteRole): "decorator" | "call" | null {
  if (role.role === "serves") {
    return "decorated" in role.handler ? "decorator" : "call";
  }
  return role.role === "mount" ? "call" : null;
}

/** The decorators that call one of the roles' methods on a value, each with the definition under it. */
function decoratedEntries(
  module: ModuleOps,
  roles: ReadonlySet<string>,
  walk: Walk,
): ReceiverEntry[] {
  if (roles.size === 0) {
    return [];
  }
  module.readingReceivers?.(roles, "decorators");
  return module.decorated().flatMap(({ definition, decorators }) =>
    decorators.flatMap((decorator) => {
      if (decorator.form !== "call") {
        return [];
      }
      const made = madeOn(decorator.call, walk);
      const name = made?.method() ?? null;
      return made !== null && name !== null && roles.has(name)
        ? [
            {
              name,
              call: decorator.call,
              made,
              decorated: definition,
              ...receiverOf(made),
            },
          ]
        : [];
    }),
  );
}

/** The call a decorator makes on a value: itself, or the library call a project wrapper it calls returns. */
function madeOn(call: CallOps, walk: Walk): CallOps | null {
  if (call.method() !== null) {
    return call;
  }
  return walk.table.throughWrappers === true
    ? (call.returnedCall?.() ?? null)
    : null;
}

/** The calls the file writes to one of the roles' methods. */
function calledEntries(
  module: ModuleOps,
  roles: ReadonlySet<string>,
): ReceiverEntry[] {
  // Listing a file's calls costs more than asking its text for a name.
  if (![...roles].some((name) => module.mentions(name))) {
    return [];
  }
  module.readingReceivers?.(roles, "calls");
  return module.calls("file").flatMap((call) => {
    const name = call.method();
    return name !== null && roles.has(name)
      ? [{ name, call, made: call, decorated: null, ...receiverOf(call) }]
      : [];
  });
}

/** The call a receiver comes to, or when it comes to none, each call it is written as. */
function receiverOf(made: CallOps): Pick<ReceiverEntry, "value" | "shared"> {
  const value = made.receiver();
  return {
    value,
    shared: value === null ? (made.receiverCalls?.() ?? []) : [],
  };
}

const ARGS_OF: {
  readonly [F in EntrySource["form"]]: (
    source: Extract<EntrySource, { form: F }>,
    keywords: readonly string[],
    defaults: Readonly<Record<string, ValueOps>>,
  ) => EntryArgs;
} = {
  call: (source, keywords, defaults) =>
    callArgs(source.call, keywords, defaults),
  element: (source, _keywords, defaults) => {
    const attributes = new Map(
      (source.value.attributes?.() ?? []).flatMap(({ key, value }) =>
        key === null ? [] : [[key, value] as const],
      ),
    );
    return keyedArgs(defaults, (key) => attributes.get(key));
  },
  object: (source, _keywords, defaults) =>
    keyedArgs(defaults, (key) => source.value.ownProperty?.(key) ?? undefined),
};

function argsOf(
  source: EntrySource,
  keywords: readonly string[],
  defaults: Readonly<Record<string, ValueOps>>,
): EntryArgs {
  const read = ARGS_OF[source.form] as (
    source: EntrySource,
    keywords: readonly string[],
    defaults: Readonly<Record<string, ValueOps>>,
  ) => EntryArgs;
  return read(source, keywords, defaults);
}

function keyedArgs(
  defaults: Readonly<Record<string, ValueOps>>,
  keyed: (key: string) => ValueOps | undefined,
): EntryArgs {
  return { positional: [], keyword: { ...defaults }, pair: null, keyed };
}

function callArgs(
  call: CallOps,
  keywords: readonly string[],
  defaults: Readonly<Record<string, ValueOps>>,
): EntryArgs {
  const pairs = call.pairArgs?.() ?? [];
  // A string key is a keyword to the adapter as well as a pair, and the
  // table reads it as a pair.
  const pairKeys = new Set(pairs.map((pair) => pair.key.text()));
  const keyword: Record<string, ValueOps> = { ...defaults };
  for (const name of keywords) {
    const value = pairKeys.has(name) ? null : (call.keywordAt?.(name) ?? null);
    if (value !== null) {
      keyword[name] = value;
    }
  }
  return {
    positional: positionalOf(call),
    keyword,
    pair: pairs[pairs.length - 1] ?? null,
    keyed: NO_KEYS,
  };
}

function picked(args: EntryArgs, pick: EntryPick): ValueOps | undefined {
  if ("at" in pick) {
    return args.positional[pick.at];
  }
  if ("keyword" in pick) {
    return args.keyword[pick.keyword];
  }
  if ("pair" in pick) {
    return args.pair?.[pick.pair];
  }
  return args.keyed(pick.key);
}

/** The value the first pick that gives one reads. */
function firstPicked(
  args: EntryArgs,
  picks: readonly EntryPick[],
): ValueOps | undefined {
  for (const pick of picks) {
    const value = picked(args, pick);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

/**
 * The word a value comes to: the element a loop variable it names is
 * bound to, or else what it evaluates to with the loop variables bound.
 * A symbol reads as its name.
 */
function wordOf(value: ValueOps | undefined, scope: Scope): string | null {
  if (value === undefined) {
    return null;
  }
  const bound =
    value.form?.() === "name"
      ? scope.bindings.get(value.source?.() ?? "")
      : undefined;
  if (bound !== undefined) {
    return bound;
  }
  const evaluated = value.evaluatedWith?.(scope.bindings) ?? null;
  return typeof evaluated === "string" ? evaluated : null;
}

function pickedWord(
  args: EntryArgs,
  pick: EntryPick | undefined,
  scope: Scope,
): string | null {
  return pick === undefined ? null : wordOf(picked(args, pick), scope);
}

/** The first pick that reads a word. */
function firstWord(
  args: EntryArgs,
  picks: readonly EntryPick[],
  scope: Scope,
): string | null {
  for (const pick of picks) {
    const word = pickedWord(args, pick, scope);
    if (word !== null) {
      return word;
    }
  }
  return null;
}

/** Whether the source writes the value out as a list here. */
function writtenAsList(value: ValueOps): boolean {
  return value.shape?.()?.type === "array";
}

/**
 * The names a pick lists: each item of a list written out that reads a
 * word, or the one word a single value reads. Null when the pick reads
 * nothing.
 */
function namesOf(
  args: EntryArgs,
  pick: EntryPick | undefined,
  scope: Scope,
): string[] | null {
  const value = pick === undefined ? undefined : picked(args, pick);
  if (value === undefined) {
    return null;
  }
  if (writtenAsList(value)) {
    return value
      .items()
      .map((item) => wordOf(item, scope))
      .filter((name): name is string => name !== null);
  }
  const single = wordOf(value, scope);
  return single === null ? null : [single];
}

function joinKey(walk: Walk, prefix: string, segment: string): string {
  return prefix === ""
    ? segment
    : `${prefix}${walk.table.handler?.namespaceJoin ?? ""}${segment}`;
}

/**
 * Joins a segment onto a path with one slash between, whether the source
 * spelled the segment as `v1`, `/v1` or `v1/`. A segment that is nothing
 * leaves the prefix, and nothing at all is `/`.
 */
export function joinRoutePath(prefix: string, segment: string): string {
  const trimmed = segment.replace(/^\/+/, "").replace(/\/+$/, "");
  const base = prefix.replace(/\/+$/, "");
  if (trimmed === "") {
    return base === "" ? "/" : base;
  }
  return joinMountedPath(base, `/${trimmed}`);
}

/**
 * A nested segment under a path, for a table that reads a segment written
 * with a leading `/` as the whole path. Any other segment goes under the
 * prefix with its trailing slashes left off.
 */
function joinStandAlone(prefix: string, segment: string): string {
  if (segment.startsWith("/")) {
    return segment;
  }
  return `${prefix}/${segment.replace(/\/+$/, "")}`;
}

/** How a library that puts a prefix and a path together as strings serves the two. */
const STRING_JOINS: Readonly<
  Record<
    NonNullable<RouteTableDeclaration["joins"]>,
    (prefix: string, segment: string) => string
  >
> = {
  asWritten: (prefix, segment) => `${prefix}${segment}`,
  merged: (prefix, segment) => `${prefix}${segment}`.replace(/\/{2,}/g, "/"),
};

function joinTablePath(walk: Walk, prefix: string, segment: string): string {
  if (walk.table.joins !== undefined) {
    return STRING_JOINS[walk.table.joins](prefix, segment);
  }
  return walk.table.absolutePaths === "standAlone"
    ? joinStandAlone(prefix, segment)
    : joinRoutePath(prefix, segment);
}

function addRoute(
  walk: Walk,
  controllerKey: string,
  action: string,
  route: TableRoute,
): void {
  const byAction =
    walk.routes.get(controllerKey) ?? new Map<string, TableRoute[]>();
  walk.routes.set(controllerKey, byAction);
  const routes = byAction.get(action) ?? [];
  byAction.set(action, routes);
  if (
    !routes.some(
      (one) => one.method === route.method && one.path === route.path,
    )
  ) {
    routes.push(route);
  }
}

function aliased(
  table: RouteTableDeclaration,
  method: string,
): readonly string[] {
  return table.methodAliases?.[method] ?? [method];
}

/** The routes one row of an expansion gives from its two bases, one for each method its method is served under. */
export function rowRoutes(
  table: RouteTableDeclaration,
  row: ExpansionRow,
  bases: { readonly collection: string; readonly member: string },
): TableRoute[] {
  const path = row.suffix.startsWith(MEMBER)
    ? `${bases.member}${row.suffix.slice(MEMBER.length)}`
    : `${bases.collection}${row.suffix}`;
  return aliased(table, row.method).map((method) => ({ method, path }));
}

/** Where a row's suffix starts from the member base. */
const MEMBER = "{member}";

/**
 * Walks an entry's children, with the list they are the entries of open
 * while they are walked. Only a value's entries can be reached again
 * while open, since a list met inside itself gives none.
 */
function walkChildren(children: Children, scope: Scope, walk: Walk): void {
  if (children.list !== null && walk.opened.includes(children.list)) {
    walkCycle(children.list, children, scope, walk);
    return;
  }
  if (children.list !== null) {
    walk.opened.push(children.list);
  }
  walkEntries(children.entries, scope, walk);
  if (children.list !== null) {
    walk.opened.pop();
  }
}

/**
 * A value mounted inside itself, which no chain of paths reaches. Its
 * entries, and everything mounted under them, are walked once more with
 * no path claimed, and a value walked that way once stops the cycle.
 */
function walkCycle(
  value: string,
  children: Children,
  scope: Scope,
  walk: Walk,
): void {
  if (walk.cycled.has(value)) {
    return;
  }
  walk.cycled.add(value);
  const router = scope.mounts[scope.mounts.length - 1]?.value;
  walkEntries(
    children.entries,
    withUnread(scope, {
      reason: "cycle",
      ...(router === undefined ? {} : { router }),
    }),
    walk,
  );
}

/** The scope with no path claimed under it, for the first reason found on the way down. */
function withUnread(scope: Scope, unread: ScopeUnread): Scope {
  return scope.unread === null ? { ...scope, unread } : scope;
}

/**
 * Walks the entries a root, a block or a file writes, which the ops list
 * through the branches of a conditional, so an entry under
 * `if Rails.env.development?` is declared in the same scope as one
 * written outside it.
 */
function walkEntries(items: readonly Walked[], scope: Scope, walk: Walk): void {
  for (const item of items) {
    if (item.form === "unread") {
      walk.outcomes.push(unreadOutcome(item));
      continue;
    }

    if (item.form === "receiver") {
      readReceiverEntry(item.entry, scope, walk);
      continue;
    }

    if (item.form === "call" && hasReceiver(item.call)) {
      replayLiteralLoop(item.call, scope, walk);
      continue;
    }

    const name = entryName(item, walk);
    const role =
      name !== null && Object.hasOwn(walk.table.roles, name)
        ? walk.table.roles[name]
        : undefined;
    if (role !== undefined && name !== null) {
      const entry: Entry = {
        source: item,
        name,
        args: argsOf(item, walk.keywords, scope.defaults),
      };
      readAs(role, entry, scope, walk);
      continue;
    }
    const unmatched = UNMATCHED[item.form] as (
      source: EntrySource,
      scope: Scope,
      walk: Walk,
    ) => void;
    unmatched(item, scope, walk);
  }
}

/** An entry made on a value, read by the role for its method, with the arguments the entry writes. */
function readReceiverEntry(
  found: ReceiverEntry,
  scope: Scope,
  walk: Walk,
): void {
  const role = walk.table.roles[found.name] as RouteRole;
  walk.read.add(found);
  readAs(
    role,
    {
      source: { form: "call", call: found.call },
      name: found.name,
      args: callArgs(found.call, walk.keywords, scope.defaults),
      decorated: found.decorated,
      on: found.value,
    },
    scope,
    walk,
  );
}

function readAs(role: RouteRole, entry: Entry, scope: Scope, walk: Walk): void {
  const read = ROLE_READERS[role.role] as RoleReader<RouteRole>;
  read(role, entry, scope, walk);
}

function unreadOutcome(item: UnreadItem): RouteOutcome {
  return {
    kind: "unread",
    reason: item.reason,
    value: item.value,
    at: item.at === undefined ? { value: item.value } : { call: item.at },
  };
}

/**
 * An entry no role reads. A call is a library's own wrapper when it has
 * entries inside, and unread otherwise. An element, such as `<Routes>`
 * or a guard around routes, is walked in place.
 */
const UNMATCHED: {
  readonly [F in EntrySource["form"]]: (
    source: Extract<EntrySource, { form: F }>,
    scope: Scope,
    walk: Walk,
  ) => void;
} = {
  call: (source, scope, walk) => {
    const name = nameOf(source.call);
    const wrapped = childrenOf(source, walk.table.roots.children, null, walk);
    if (wrapped !== null && wrapsEntries(wrapped, walk)) {
      walk.gaps.push({ kind: "walkedBlock", file: walk.file, name });
      walkChildren(wrapped, scope, walk);
      return;
    }
    walk.gaps.push({ kind: "unread", file: walk.file, name });
  },
  element: (source, scope, walk) => {
    const inside = childrenOf(source, { in: "elements" }, null, walk);
    if (inside !== null) {
      walkChildren(inside, scope, walk);
    }
  },
  object: () => undefined,
};

/**
 * A library's own wrapper, such as `devise_scope :user do ... end`, has
 * entries the table knows inside and leaves their path and handler
 * alone. One with no such entry, such as `direct`, stays unread.
 */
function wrapsEntries(children: Children, walk: Walk): boolean {
  return children.entries.some(
    (inner) =>
      inner.form === "call" &&
      !hasReceiver(inner.call) &&
      Object.hasOwn(walk.table.roles, nameOf(inner.call)),
  );
}

/**
 * `%w[users u].each do |root_path| ... end` declares its children once
 * per element, so they are walked once per element with the variable
 * bound. A loop over anything but a list written out in place is
 * skipped, because its elements are unknown here.
 */
function replayLiteralLoop(call: CallOps, scope: Scope, walk: Walk): void {
  const loop = call.loopsOver?.() ?? null;
  const children = childrenOf(
    { form: "call", call },
    walk.table.roots.children,
    null,
    walk,
  );
  if (
    loop === null ||
    children === null ||
    !walk.table.loops.includes(call.method() ?? "") ||
    !writtenAsList(loop.over)
  ) {
    return;
  }
  loop.over.items().forEach((item, position) => {
    const word = wordOf(item, scope);
    if (word === null) {
      return;
    }
    const bindings = new Map(scope.bindings);
    bindings.set(loop.element, word);
    if (loop.position !== null) {
      bindings.set(loop.position, String(position));
    }
    walkChildren(children, { ...scope, bindings }, walk);
  });
}

type RoleReader<R extends RouteRole> = (
  role: R,
  entry: Entry,
  scope: Scope,
  walk: Walk,
) => void;

const ROLE_READERS: {
  readonly [K in RouteRole["role"]]: RoleReader<
    Extract<RouteRole, { role: K }>
  >;
} = {
  serves: readServes,
  expands: readExpands,
  scopes: readScopes,
  base: readBase,
  defaults: readDefaults,
  fragment: readFragment,
  replay: readReplay,
  include: readInclude,
  mount: readMount,
};

function readDefaults(
  role: DefaultsRole,
  entry: Entry,
  scope: Scope,
  walk: Walk,
): void {
  const children = childrenOf(entry.source, role.children, entry.args, walk);
  if (children !== null) {
    walkChildren(children, { ...scope, defaults: entry.args.keyword }, walk);
  }
}

function readFragment(
  role: FragmentRole,
  entry: Entry,
  scope: Scope,
  walk: Walk,
): void {
  const name = pickedWord(entry.args, role.name, scope);
  const children = childrenOf(entry.source, role.children, entry.args, walk);
  if (name !== null && children !== null) {
    walk.fragments.set(name, children);
  }
}

function readReplay(
  role: ReplayRole,
  entry: Entry,
  scope: Scope,
  walk: Walk,
): void {
  const names = entry.args.positional
    .slice(role.names.from)
    .map((value) => wordOf(value, scope))
    .filter((name): name is string => name !== null);
  replayFragments(names, scope, walk);
}

/** Walks each named fragment's children in the scope the replay is written in. */
function replayFragments(
  names: readonly string[],
  scope: Scope,
  walk: Walk,
): void {
  for (const name of names) {
    const children = walk.fragments.get(name);
    if (children !== undefined) {
      walkChildren(children, scope, walk);
    }
  }
}

function readServes(
  role: ServesRole,
  entry: Entry,
  scope: Scope,
  walk: Walk,
): void {
  if ("decorated" in role.handler) {
    readServesDecorated(role, entry, scope, walk);
    return;
  }
  if ("value" in role.handler) {
    readServesValue(role, role.handler.value, entry, scope, walk);
    return;
  }
  for (const method of methodsOf(role, entry.args, scope, walk)) {
    serveAt(role, role.handler, entry.args, scope, walk, method);
  }
}

/** One route a served entry gives: its method, the handler, and the class a method handler is written in. */
interface Served {
  readonly method: string;
  readonly handler: ValueOps;
  readonly owner?: ValueOps;
}

/**
 * A decorator entry serves the definition under it at the decorator's
 * path: a function under each of the role's methods, or each method of
 * a class that `members` lists, as the handler of a route of its own.
 */
function readServesDecorated(
  role: ServesRole,
  entry: Entry,
  scope: Scope,
  walk: Walk,
): void {
  const definition = entry.decorated ?? null;
  const own = ownPathOf(role, entry.args, scope);
  if (definition === null || own.kind === "none") {
    return;
  }
  const served = servedBy(role, definition, entry.args, scope, walk);
  const unread = unreadAt(scope, own);
  if (unread !== null) {
    const prefix = scope.unread === null ? { prefix: scope.pathPrefix } : {};
    for (const one of served) {
      walk.outcomes.push({
        ...unreadEntry(unread, one, entry.source, {
          mounts: scope.mounts,
          on: entry.on ?? null,
        }),
        method: one.method,
        ...prefix,
      });
    }
    return;
  }
  const path = servedPath(scope, own, walk);
  for (const one of served) {
    walk.outcomes.push({
      kind: "route",
      method: one.method,
      path,
      handler: one.handler,
      entry: entry.source,
      ...(one.owner === undefined ? {} : { owner: one.owner }),
      mounts: scope.mounts,
      prefix: scope.pathPrefix,
    });
  }
}

function servedBy(
  role: ServesRole,
  definition: ValueOps,
  args: EntryArgs,
  scope: Scope,
  walk: Walk,
): Served[] {
  if (!("members" in role.methods)) {
    return methodsOf(role, args, scope, walk).map((method) => ({
      method,
      handler: definition,
    }));
  }
  const { members } = role.methods;
  return (definition.asClass?.()?.members("instance") ?? [])
    .filter((member) => members.includes(member.name))
    .map((member) => ({
      method: member.name.toUpperCase(),
      handler: member.value,
      owner: definition,
    }));
}

/** Why the path an entry would serve is not claimed: something above it, or its own path. Null when it reads. */
function unreadAt(scope: Scope, own: OwnPath): UnreadWhy | null {
  if (scope.unread !== null) {
    return scope.unread;
  }
  return own.kind === "unread" ? { reason: "pathUnread" } : null;
}

/** Where an entry found through a receiver is: the mounts the walk came down, and the value it is made on. */
interface ReceiverPlace {
  readonly mounts?: readonly MountHop[];
  readonly on: CallOps | null;
}

function unreadEntry(
  unread: UnreadWhy,
  served: Omit<Served, "method">,
  entry: EntrySource,
  place?: ReceiverPlace,
): Extract<RouteOutcome, { kind: "unread"; handler: ValueOps }> {
  return {
    kind: "unread",
    reason: unread.reason,
    handler: served.handler,
    entry,
    ...(served.owner === undefined ? {} : { owner: served.owner }),
    ...(unread.loops === undefined ? {} : { loops: unread.loops }),
    ...(place?.mounts === undefined ? {} : { mounts: place.mounts }),
    ...(place === undefined || place.on === null ? {} : { on: place.on }),
    ...(unread.router === undefined ? {} : { router: unread.router }),
    ...(unread.shared === undefined ? {} : { shared: unread.shared }),
  };
}

/** The path an entry whose own path reads serves at: its segment under the scope, or the scope's own path. */
function servedPath(scope: Scope, own: OwnPath, walk: Walk): string {
  return own.kind === "segment"
    ? joinTablePath(walk, scope.pathPrefix, own.segment)
    : scope.pathPrefix || "/";
}

/** What an entry whose handler is a value says about its own path. */
type OwnPath =
  | { readonly kind: "segment"; readonly segment: string }
  | { readonly kind: "unread" }
  | { readonly kind: "index" }
  | { readonly kind: "none" };

/**
 * An entry whose handler is a value, such as React Router's
 * `<Route path element>`, serves its handler at its path, or at the
 * scope's own path when its index flag reads true. The entries nested
 * under it walk under its path; one with neither path nor index serves
 * nothing and leaves the path to its children as it is. A path that does
 * not read leaves no path to claim for it or for anything under it.
 */
function readServesValue(
  role: ServesRole,
  handlerPicks: readonly EntryPick[],
  entry: Entry,
  scope: Scope,
  walk: Walk,
): void {
  const handler = firstPicked(entry.args, handlerPicks);
  const own = ownPathOf(role, entry.args, scope);
  if (handler !== undefined && own.kind !== "none") {
    serveValue(role, entry, scope, walk, handler, own);
  }
  const inside = scopeInside(scope, own, walk);
  for (const rule of role.children ?? []) {
    const children = childrenOf(entry.source, rule, entry.args, walk);
    if (children !== null) {
      walkChildren(children, inside, walk);
      return;
    }
  }
}

function ownPathOf(role: ServesRole, args: EntryArgs, scope: Scope): OwnPath {
  if ("fixed" in role.path) {
    return { kind: "index" };
  }
  const value = firstPicked(args, role.path);
  if (value !== undefined) {
    const segment = wordOf(value, scope);
    return segment === null ? { kind: "unread" } : { kind: "segment", segment };
  }
  if (role.index !== undefined && picked(args, role.index)?.flag() === true) {
    return { kind: "index" };
  }
  return { kind: "none" };
}

function scopeInside(scope: Scope, own: OwnPath, walk: Walk): Scope {
  if (scope.unread !== null) {
    return scope;
  }
  if (own.kind === "unread") {
    return { ...scope, unread: { reason: "prefixUnread" } };
  }
  if (own.kind === "segment") {
    return {
      ...scope,
      pathPrefix: joinTablePath(walk, scope.pathPrefix, own.segment),
    };
  }
  return scope;
}

function serveValue(
  role: ServesRole,
  entry: Entry,
  scope: Scope,
  walk: Walk,
  handler: ValueOps,
  own: Exclude<OwnPath, { kind: "none" }>,
): void {
  const unread = unreadAt(scope, own);
  if (unread !== null) {
    walk.outcomes.push(unreadEntry(unread, { handler }, entry.source));
    return;
  }
  const path = servedPath(scope, own, walk);
  for (const method of methodsOf(role, entry.args, scope, walk)) {
    walk.outcomes.push({
      kind: "route",
      method,
      path,
      handler,
      entry: entry.source,
    });
  }
}

/** The methods an entry serves its one handler under. A role whose methods are a class's members gives none here. */
function methodsOf(
  role: ServesRole,
  args: EntryArgs,
  scope: Scope,
  walk: Walk,
): readonly string[] {
  if (Array.isArray(role.methods)) {
    return role.methods.flatMap((method) => aliased(walk.table, method));
  }
  const methods = role.methods as
    | { readonly pick: EntryPick; readonly all?: string }
    | { readonly members: readonly string[] };
  if ("members" in methods) {
    return [];
  }
  const { pick, all } = methods;
  const names = namesOf(args, pick, scope) ?? [];
  if (all !== undefined && names.includes(all)) {
    return ["*"];
  }
  return names.map((name) => name.toUpperCase());
}

/** The controller key and action a handler's text gives, or null when it has no separator. */
function handlerNamed(
  text: string,
  walk: Walk,
): { controllerKey: string; action: string } | null {
  const separator = walk.table.handler?.separator;
  const index = separator === undefined ? -1 : text.indexOf(separator);
  if (separator === undefined || index === -1) {
    return null;
  }
  return {
    controllerKey: text.slice(0, index),
    action: text.slice(index + separator.length),
  };
}

/** The handler the first pick that reads as one gives. */
function handlerOf(
  picks: readonly EntryPick[],
  args: EntryArgs,
  scope: Scope,
  walk: Walk,
): { controllerKey: string; action: string } | null {
  for (const pick of picks) {
    const word = pickedWord(args, pick, scope);
    const handler = word === null ? null : handlerNamed(word, walk);
    if (handler !== null) {
      return handler;
    }
  }
  return null;
}

function serveAt(
  role: ServesRole,
  handlerPicks: readonly EntryPick[],
  args: EntryArgs,
  scope: Scope,
  walk: Walk,
  method: string,
): void {
  const handler = handlerOf(handlerPicks, args, scope, walk);
  if ("fixed" in role.path) {
    if (handler !== null) {
      addRoute(
        walk,
        joinKey(walk, scope.namespace, handler.controllerKey),
        handler.action,
        {
          method,
          path: scope.pathPrefix === "" ? "/" : scope.pathPrefix,
        },
      );
    }
    return;
  }
  const on = pickedWord(args, role.bare?.on, scope);
  const base =
    scope.expansion === undefined
      ? scope.pathPrefix
      : baseForOn(scope.expansion, on);
  const served =
    handler === null
      ? bareRoute(role, args, scope, walk)
      : stated(handler, role.path, args, scope, walk);
  if (served === null) {
    return;
  }
  const formatless =
    role.formatless !== undefined &&
    picked(args, role.formatless.pick)?.flag() === role.formatless.when;
  addRoute(walk, served.controllerKey, served.action, {
    method,
    path: joinRoutePath(base, served.path),
    ...(formatless ? { formatless: true } : {}),
  });
}

interface ServedAt {
  readonly controllerKey: string;
  readonly action: string;
  readonly path: string;
}

/** The handler the entry states, at the first path its picks read. */
function stated(
  handler: { controllerKey: string; action: string },
  paths: readonly EntryPick[],
  args: EntryArgs,
  scope: Scope,
  walk: Walk,
): ServedAt | null {
  const path = firstWord(args, paths, scope);
  return path === null
    ? null
    : {
        controllerKey: joinKey(walk, scope.namespace, handler.controllerKey),
        action: handler.action,
        path,
      };
}

/** The base path an entry inside an expansion starts from, given its `on`. */
function baseForOn(expansion: Expansion, on: string | null): string {
  if (on === "collection") {
    return expansion.collectionBase;
  }
  if (on === "member") {
    return expansion.memberBase;
  }
  return expansion.ambientBase;
}

/** Where an entry that states no handler routes to, with its namespace joined. */
function bareRoute(
  role: ServesRole,
  args: EntryArgs,
  scope: Scope,
  walk: Walk,
): ServedAt | null {
  const bare = role.bare;
  const path = pickedWord(args, bare?.path, scope);
  if (bare === undefined || path === null) {
    return null;
  }
  const action =
    pickedWord(args, bare.action, scope) ?? actionFromPath(path, bare.wordRule);
  const controller = pickedWord(args, bare.controller, scope);
  const controllerKey =
    controller !== null
      ? joinKey(walk, scope.namespace, controller)
      : scope.expansion?.controllerKey;
  return controllerKey === undefined || action === null
    ? null
    : { controllerKey, action, path };
}

/**
 * The path as an action when it is one word, with the rule's character
 * replaced. A path with any other character in it, a slash or a
 * parameter's colon, gives no action.
 */
function actionFromPath(
  path: string,
  rule: { readonly replace: readonly [string, string] },
): string | null {
  const [from, to] = rule.replace;
  const word = new RegExp(`^[\\w${escapeForClass(from)}]+$`);
  return word.test(path) ? path.replaceAll(from, to) : null;
}

function escapeForClass(text: string): string {
  return text.replace(/[\\\]^-]/g, "\\$&");
}

function readExpands(
  role: ExpandsRole,
  entry: Entry,
  scope: Scope,
  walk: Walk,
): void {
  const { args } = entry;
  const name = pickedWord(args, role.name, scope);
  if (name === null) {
    return;
  }
  const naming = walk.sources.naming;
  const controllerSegment =
    pickedWord(args, role.controller, scope) ??
    (role.controllerNaming === "plural" ? naming.plural(name) : name);
  const moduleName = pickedWord(args, role.module, scope);
  const namespace =
    moduleName === null
      ? scope.namespace
      : joinKey(walk, scope.namespace, moduleName);
  const controllerKey = joinKey(walk, namespace, controllerSegment);
  const segment = pickedWord(args, role.path, scope) ?? name;
  const base = joinRoutePath(
    scope.expansion?.nestedBase ?? scope.pathPrefix,
    segment,
  );
  const shallow = scope.shallow || pickedFlag(args, role.shallow) === true;
  const bases = expansionBases(role, {
    base,
    // A shallow expansion's member routes leave the expansions around it
    // and start from the shallow path.
    memberFrom:
      shallow && role.member === "id"
        ? joinRoutePath(scope.shallowPath, segment)
        : base,
    param: pickedWord(args, role.param, scope) ?? "id",
    singular: naming.singular(name),
  });

  const only = namesOf(args, role.only, scope);
  const except = namesOf(args, role.except, scope);
  for (const [action, rows] of Object.entries(role.rows)) {
    if (only !== null && !only.includes(action)) {
      continue;
    }

    if (except?.includes(action)) {
      continue;
    }

    for (const route of rows.flatMap((row) =>
      rowRoutes(walk.table, row, {
        collection: base,
        member: bases.memberBase,
      }),
    )) {
      addRoute(walk, controllerKey, action, route);
    }
  }

  const inside: Scope = {
    ...scope,
    namespace,
    shallow,
    expansion: {
      controllerKey,
      collectionBase: base,
      memberBase: bases.memberBase,
      nestedBase: bases.nestedBase,
      ambientBase: bases.nestedBase,
    },
  };
  replayFragments(namesOf(args, role.concerns, scope) ?? [], inside, walk);
  const children = childrenOf(entry.source, role.children, args, walk);
  if (children !== null) {
    walkChildren(children, inside, walk);
  }
}

function pickedFlag(
  args: EntryArgs,
  pick: EntryPick | undefined,
): boolean | null {
  return pick === undefined ? null : (picked(args, pick)?.flag() ?? null);
}

/**
 * The member base and the base a nested expansion goes under. The
 * nesting parameter comes from the entry's own name and its `param`,
 * whatever `path:` said the URL reads.
 */
function expansionBases(
  role: ExpandsRole,
  at: {
    readonly base: string;
    readonly memberFrom: string;
    readonly param: string;
    readonly singular: string;
  },
): { memberBase: string; nestedBase: string } {
  return {
    memberBase:
      role.member === "id" ? `${at.memberFrom}/:${at.param}` : at.base,
    nestedBase:
      role.nested === "singularId"
        ? `${at.memberFrom}/:${at.singular}_${at.param}`
        : at.base,
  };
}

function readScopes(
  role: ScopesRole,
  entry: Entry,
  scope: Scope,
  walk: Walk,
): void {
  const children = childrenOf(entry.source, role.children, entry.args, walk);
  if (children === null) {
    return;
  }
  if (role.noValue !== undefined) {
    walkChildren(
      children,
      prefixedScope(role, role.noValue, entry, scope, walk),
      walk,
    );
    return;
  }
  if (
    role.both === undefined &&
    role.path === undefined &&
    role.namespace === undefined
  ) {
    walkChildren(children, scope, walk);
    return;
  }
  const segments = scopeSegments(role, entry.args, scope);
  if (segments !== null) {
    walkChildren(children, enterScope(scope, segments, role, walk), walk);
  }
}

/**
 * The scope under a library's router, read the way the library reads its
 * prefix. One that does not read, or none where the library makes one
 * up, leaves every route under it unread, ahead of what the mounts above
 * it say, since the router's own prefix is what it is built with.
 */
function prefixedScope(
  role: ScopesRole,
  noValue: "unstated" | "unreadable",
  entry: Entry,
  scope: Scope,
  walk: Walk,
): Scope {
  const prefix = prefixRead(
    firstPicked(entry.args, role.path ?? []),
    noValue,
    scope,
  );
  const unread = unreadPrefix(
    role,
    prefix,
    entry.source.form === "call" ? entry.source.call : null,
  );
  if (unread !== null) {
    return { ...scope, unread };
  }
  if (prefix.kind !== "stated") {
    return scope;
  }
  const path =
    role.trailingSlash === "trimmed"
      ? prefix.value.replace(/\/+$/, "")
      : prefix.value;
  return { ...scope, pathPrefix: joinTablePath(walk, scope.pathPrefix, path) };
}

/** Why a library's router claims no path for what is under it from its own prefix alone, or null when the prefix gives it one. */
function unreadPrefix(
  role: ScopesRole,
  prefix: PrefixRead,
  router: CallOps | null,
): ScopeUnread | null {
  const about = router === null ? {} : { router };
  if (prefix.kind === "unreadable") {
    return { reason: "prefixUnread", ...about };
  }
  if (prefix.kind === "unstated" && role.prefixRequired === true) {
    return { reason: "prefixUnstated", ...about };
  }
  return null;
}

/** What a library prefix says where it is written: a path, none at all, or something that does not read as a string. */
type PrefixRead =
  | { readonly kind: "stated"; readonly value: string }
  | { readonly kind: "unstated" }
  | { readonly kind: "unreadable" };

function prefixRead(
  value: ValueOps | undefined,
  noValue: "unstated" | "unreadable",
  scope: Scope,
): PrefixRead {
  if (value === undefined || (noValue === "unstated" && writesNoValue(value))) {
    return { kind: "unstated" };
  }
  const word = wordOf(value, scope);
  return word === null
    ? { kind: "unreadable" }
    : { kind: "stated", value: word };
}

/** What a library that tests its prefix for truth reads as none: `""`, `0`, `false`, or the language's literal for no value. */
function writesNoValue(value: ValueOps): boolean {
  const literal = value.literal?.() ?? null;
  return (
    literal === "" ||
    literal === 0 ||
    literal === false ||
    value.nothing?.() === true
  );
}

/** The path and namespace segments a scope adds, or null when its one word for both reads nothing. */
function scopeSegments(
  role: ScopesRole,
  args: EntryArgs,
  scope: Scope,
): { path: string | null; namespace: string | null } | null {
  if (role.both !== undefined) {
    const both = pickedWord(args, role.both, scope);
    return both === null ? null : { path: both, namespace: both };
  }
  return {
    path: firstWord(args, role.path ?? [], scope),
    namespace: firstWord(args, role.namespace ?? [], scope),
  };
}

/**
 * The scope a scopes entry's children walk under. Inside an expansion
 * the path continues from where a nested expansion would go, such as
 * `/users/:user_id`. The expansion itself is left, so an entry inside
 * that states no controller is not read.
 */
function enterScope(
  scope: Scope,
  segments: { path: string | null; namespace: string | null },
  role: ScopesRole,
  walk: Walk,
): Scope {
  const base = scope.expansion?.nestedBase ?? scope.pathPrefix;
  const { expansion: _left, ...kept } = scope;
  return {
    ...kept,
    pathPrefix:
      segments.path !== null ? joinRoutePath(base, segments.path) : base,
    namespace:
      segments.namespace !== null
        ? joinKey(walk, scope.namespace, segments.namespace)
        : scope.namespace,
    shallowPath:
      role.shallowPath === true && segments.path !== null
        ? joinRoutePath(scope.shallowPath, segments.path)
        : scope.shallowPath,
  };
}

function readBase(
  role: BaseRole,
  entry: Entry,
  scope: Scope,
  walk: Walk,
): void {
  const expansion = scope.expansion;
  const children = childrenOf(entry.source, role.children, entry.args, walk);
  if (expansion === undefined || children === null) {
    return;
  }
  const ambientBase =
    role.which === "member" ? expansion.memberBase : expansion.collectionBase;
  walkChildren(
    children,
    { ...scope, expansion: { ...expansion, ambientBase } },
    walk,
  );
}

function readInclude(
  role: IncludeRole,
  entry: Entry,
  scope: Scope,
  walk: Walk,
): void {
  const name = pickedWord(entry.args, role.name, scope);
  if (name === null || walk.included.has(name)) {
    return;
  }
  walk.included.add(name);
  const module = walk.sources.include(name);
  if (module === null) {
    walk.gaps.push({ kind: "missingInclude", file: walk.file, name });
    return;
  }
  walkChildren(callsAsChildren(module.bodyCalls()), scope, walk);
}

/** The first pick that gives a value, read as the source writes it. */
function firstSource(
  args: EntryArgs,
  picks: readonly EntryPick[],
): string | null {
  const value = firstPicked(args, picks);
  return value === undefined ? null : (value.source?.() ?? null);
}

/** The first pick that gives a value, read as a word. */
function firstValueWord(
  args: EntryArgs,
  picks: readonly EntryPick[],
  scope: Scope,
): string | null {
  const pick = picks.find((one) => picked(args, one) !== undefined);
  return pickedWord(args, pick, scope);
}

/**
 * Serves the mounted table's first root under the mount's path, keyed
 * under the table's namespace, whatever namespace the mount is written
 * in. A mount of anything that is not a mounted table, or of the table
 * being walked, is recorded as unread.
 */
function readMount(
  role: MountRole,
  entry: Entry,
  scope: Scope,
  walk: Walk,
): void {
  if (role.prefix !== undefined) {
    readValueMount(role, role.prefix, entry, scope, walk);
    return;
  }
  const written = firstSource(entry.args, role.table);
  const owner = written === null ? null : walk.sources.ownerOf(written);
  const mountPath = firstValueWord(entry.args, role.at, scope);
  if (
    owner === null ||
    owner.table !== "mounted" ||
    mountPath === null ||
    walk.mounting.has(owner.name)
  ) {
    walk.gaps.push({ kind: "unread", file: walk.file, name: entry.name });
    return;
  }
  const root = walk.mounted.get(owner.name);
  if (root === undefined) {
    return;
  }
  walk.mounting.add(owner.name);
  const prefix = joinRoutePath(scope.pathPrefix, mountPath);
  inFile(walk, root.displayPath, () => {
    walkChildren(
      root.children,
      {
        ...EMPTY_SCOPE,
        pathPrefix: prefix,
        namespace: owner.namespace,
        shallowPath: prefix,
      },
      walk,
    );
  });
  walk.mounting.delete(owner.name);
}

/** The loop whose variable a mount's table can be: a `for` statement, which the facts state with `elementOf`. */
const FOR_LOOP = "for";

/** What a mount's table comes to: the calls that built the values it mounts, or a loop the table cannot list. */
type Mounted =
  | { readonly kind: "values"; readonly calls: readonly CallOps[] }
  | { readonly kind: "unlisted" };

const UNLISTED: Mounted = { kind: "unlisted" };

/**
 * The values a mount's table comes to: the call that built it, through
 * names and fields, or for the variable of a `for` loop, the call behind
 * each item of the list the loop goes over, written out in place or
 * returned by a call the rules settle. A loop over anything else, or
 * over an item that comes to no call, is one the table cannot list.
 */
function mountedOf(value: ValueOps | undefined, walk: Walk): Mounted {
  const built = value?.asCall?.({ follow: "namesAndFields" }) ?? null;
  if (built !== null) {
    return { kind: "values", calls: [built] };
  }
  if (!walk.table.loops.includes(FOR_LOOP)) {
    return { kind: "values", calls: [] };
  }
  const over = value?.element?.() ?? null;
  if (over === null) {
    // A loop that takes each element apart says no more about which value
    // a part is than a loop over a list the table cannot read.
    return (value?.elementPart?.() ?? null) === null
      ? { kind: "values", calls: [] }
      : UNLISTED;
  }
  const items = itemsLooped(over);
  if (items === null) {
    return UNLISTED;
  }
  const calls = items.flatMap(
    (item) => item.asCall?.({ follow: "namesAndFields" }) ?? [],
  );
  return calls.length === items.length ? { kind: "values", calls } : UNLISTED;
}

/**
 * The items of what a loop goes over: a list written out in place, or a
 * call the rules settle on one. A call that returns no item says no more
 * about what the loop mounts than one they do not settle.
 */
function itemsLooped(over: ValueOps): readonly ValueOps[] | null {
  if (writtenAsList(over)) {
    return over.items();
  }
  const returned = over.returnedItems?.() ?? null;
  return returned === null || returned.length === 0 ? null : returned;
}

/** What a mount of a value the source built comes to, or null for an entry that is no such mount. */
function valueMounted(entry: ReceiverEntry, walk: Walk): Mounted | null {
  const role = walk.table.roles[entry.name];
  if (role?.role !== "mount" || role.prefix === undefined) {
    return null;
  }
  const args = callArgs(entry.call, walk.keywords, {});
  return mountedOf(firstPicked(args, role.table), walk);
}

/**
 * A mount of a value the source built, such as `include_router(router,
 * prefix=...)`: the call that built each value is walked as an entry,
 * under the mount's path.
 */
function readValueMount(
  role: MountRole,
  prefix: "inFront" | "replaces",
  entry: Entry,
  scope: Scope,
  walk: Walk,
): void {
  const mounted = mountedOf(firstPicked(entry.args, role.table), walk);
  if (mounted.kind === "unlisted") {
    return;
  }
  const at = prefixRead(
    firstPicked(entry.args, role.at),
    role.noValue ?? "unreadable",
    scope,
  );
  for (const value of mounted.calls) {
    walkMountedValue(
      value,
      mountedScope(at, prefix, entry, value, scope, walk),
      walk,
    );
  }
}

/**
 * The scope a mounted value is walked in: under the path the mount
 * states, or with no path claimed when that path does not read, when it
 * replaces the value's own, or when a loop may mount the value instead.
 */
function mountedScope(
  at: PrefixRead,
  prefix: "inFront" | "replaces",
  entry: Entry,
  value: CallOps,
  scope: Scope,
  walk: Walk,
): Scope {
  const mount = entry.source.form === "call" ? entry.source.call : null;
  const through: Scope =
    mount === null
      ? scope
      : { ...scope, mounts: [...scope.mounts, { call: mount, value }] };
  if (at.kind === "unreadable") {
    return withUnread(through, { reason: "mountUnread", router: value });
  }
  if (at.kind === "stated" && prefix === "replaces") {
    return withUnread(through, { reason: "prefixReplaced", router: value });
  }
  const placed =
    at.kind === "stated"
      ? {
          ...through,
          pathPrefix: joinTablePath(walk, through.pathPrefix, at.value),
        }
      : through;
  const loops = mount === null ? [] : rivalsOf(mount, value, walk);
  return loops.length === 0
    ? placed
    : withUnread(placed, { reason: "rivalledMount", loops, router: value });
}

/** A mounted value, read by the role for the call that built it, named the way that call's own file names it. */
function walkMountedValue(value: CallOps, scope: Scope, walk: Walk): void {
  const name = builtName(value, walk);
  if (name === null || !Object.hasOwn(walk.table.roles, name)) {
    return;
  }
  readAs(
    walk.table.roles[name] as RouteRole,
    {
      source: { form: "call", call: value },
      name,
      args: callArgs(value, walk.keywords, {}),
    },
    scope,
    walk,
  );
}

/**
 * The loops the table cannot list that may mount the value in place of a
 * mount written in a function: each written somewhere else, in a
 * directory that contains the value's file. A mount at the top of a file
 * runs when the file is imported, so nothing rivals it.
 */
function rivalsOf(mount: CallOps, value: CallOps, walk: Walk): CallOps[] {
  const site = mount.callerSite?.() ?? null;
  if (site === null) {
    return [];
  }
  const file = value.file?.() ?? null;
  return loopsOnTable(walk).filter(
    (loop) => (loop.callerSite?.() ?? null) !== site && mayMount(loop, file),
  );
}

/** The mounts in a loop the table cannot list that are made on a value the table reads, as a mount the walk would follow is. */
function loopsOnTable(walk: Walk): CallOps[] {
  return receiversOf(walk)
    .unlisted.filter((loop) => onTableValue(loop, walk))
    .map((loop) => loop.call);
}

/** Whether a loop may mount a value written in the file. A loader reads what it mounts from near itself, the directory it is in. */
function mayMount(loop: CallOps, file: string | null): boolean {
  const loopFile = loop.file?.() ?? null;
  return (
    file === null ||
    loopFile === null ||
    file.startsWith(loopFile.slice(0, loopFile.lastIndexOf("/") + 1))
  );
}

/**
 * Each decorated entry no walk read, so a route on a router nobody
 * mounts still has its handler, said with the loops the table cannot
 * list that may mount its value.
 */
function sayUnreached(walk: Walk): void {
  if (!readsReceivers(walk.table)) {
    return;
  }
  const receivers = receiversOf(walk);
  for (const found of receivers.decorated) {
    if (walk.read.has(found) || !onTableValue(found, walk)) {
      continue;
    }

    // A root adds no path, so whichever of the roots a name is assigned
    // runs serves the entry at its own path.
    if (
      found.shared.length > 0 &&
      found.shared.every((one) => isRoot(one, walk))
    ) {
      readReceiverEntry(found, EMPTY_SCOPE, walk);
      continue;
    }

    const unread = whyUnreached(found, walk);
    const served = servedBy(
      walk.table.roles[found.name] as ServesRole,
      found.decorated as ValueOps,
      callArgs(found.call, walk.keywords, {}),
      EMPTY_SCOPE,
      walk,
    );
    for (const one of served) {
      walk.outcomes.push({
        ...unreadEntry(
          unread,
          one,
          { form: "call", call: found.call },
          { on: found.value },
        ),
        method: one.method,
      });
    }
  }
}

/**
 * Why no walk reached an entry, in the order a library would stop
 * serving it: the value's own prefix, which it is built with wherever it
 * is mounted; then each mount of the value, by the prefix of the value it
 * mounts it onto, its own prefix, and a loop that may mount the value in
 * its place; then the value it is mounted onto, which no walk reached
 * either. A value nothing mounts gives the loops that may mount it.
 */
function whyUnreached(found: ReceiverEntry, walk: Walk): UnreadWhy {
  const { value } = found;
  if (value === null) {
    return found.shared.length > 0
      ? { reason: "unreached", shared: true }
      : { reason: "unreached" };
  }
  const own = scopeUnreadOf(value, walk);
  if (own !== null) {
    return own;
  }
  const mounts = (
    receiversOf(walk).mountedBy.get(value.site?.() ?? "") ?? []
  ).filter((mount) => mount.value !== null && onTableValue(mount, walk));
  for (const mount of mounts) {
    const unread = mountUnreadOf(mount, value, walk);
    if (unread !== null) {
      return unread;
    }
  }
  const onto = mounts[0]?.value ?? null;
  if (onto !== null) {
    return { reason: "unreached", router: onto };
  }
  const loops = loopsOnTable(walk).filter((loop) =>
    mayMount(loop, found.call.file?.() ?? null),
  );
  return loops.length === 0
    ? { reason: "unreached" }
    : { reason: "unlistedLoop", loops };
}

/** Why one mount of a value would leave it with no path, read the way the walk reads a mount it reaches, or null when it would not. */
function mountUnreadOf(
  mount: ReceiverEntry,
  value: CallOps,
  walk: Walk,
): UnreadWhy | null {
  const onto = mount.value === null ? null : scopeUnreadOf(mount.value, walk);
  if (onto !== null) {
    return onto;
  }
  const role = walk.table.roles[mount.name] as MountRole;
  const at = prefixRead(
    firstPicked(callArgs(mount.call, walk.keywords, {}), role.at),
    role.noValue ?? "unreadable",
    EMPTY_SCOPE,
  );
  if (at.kind === "unreadable") {
    return { reason: "mountUnread", router: value };
  }
  if (at.kind === "stated" && role.prefix === "replaces") {
    return { reason: "prefixReplaced", router: value };
  }
  const loops = rivalsOf(mount.call, value, walk);
  return loops.length === 0
    ? null
    : { reason: "rivalledMount", loops, router: value };
}

/** Why a value a scopes role is written as claims no path under it from its own prefix, or null when it is no such value or its prefix reads. */
function scopeUnreadOf(value: CallOps, walk: Walk): ScopeUnread | null {
  const name = builtName(value, walk);
  const role =
    name !== null && Object.hasOwn(walk.table.roles, name)
      ? walk.table.roles[name]
      : undefined;
  if (role?.role !== "scopes" || role.noValue === undefined) {
    return null;
  }
  const prefix = prefixRead(
    firstPicked(callArgs(value, walk.keywords, {}), role.path ?? []),
    role.noValue,
    EMPTY_SCOPE,
  );
  return unreadPrefix(role, prefix, value);
}

/** Whether some entry's children are the entries made on a value, which only such a table finds. */
function readsReceivers(table: RouteTableDeclaration): boolean {
  return [
    table.roots.children,
    ...Object.values(table.roles).flatMap(childrenRulesOf),
  ].some((rule) => rule.in === "receiver");
}

function childrenRulesOf(role: RouteRole): readonly ChildrenIn[] {
  if (!("children" in role) || role.children === undefined) {
    return [];
  }
  return "in" in role.children ? [role.children] : role.children;
}

/**
 * Whether an entry is made on a value the table reads, and so belongs to
 * it: one a root or a role is written as, and not one its function
 * builds and drops, whether a root or a value a root would mount. A
 * receiver that comes to no one call counts when `receiverIsFrom` says
 * the table's modules built it.
 */
function onTableValue(found: ReceiverEntry, walk: Walk): boolean {
  const { value } = found;
  const { from } = walk.table;
  if (value === null && found.shared.length > 0) {
    return found.shared.every((one) => tableValue(one, walk));
  }
  if (value === null) {
    return (
      from !== undefined && found.made.receiverIsFrom(constructedFrom(...from))
    );
  }
  return tableValue(value, walk);
}

/** Whether a call builds a value the table reads: a root or a role, kept by its function. */
function tableValue(value: CallOps, walk: Walk): boolean {
  const name = builtName(value, walk);
  if (name === null || walk.dropped.has(value.site?.() ?? "")) {
    return false;
  }
  if (Object.hasOwn(walk.table.roots.kinds, name)) {
    return true;
  }
  return Object.hasOwn(walk.table.roles, name) && !droppedValue(value, walk);
}

function isRoot(value: CallOps, walk: Walk): boolean {
  const name = builtName(value, walk);
  return name !== null && Object.hasOwn(walk.table.roots.kinds, name);
}

/** The name the call that built a value is matched by, read the way its own file names it. */
function builtName(value: CallOps, walk: Walk): string | null {
  const names = receiversOf(walk).names.get(value.file?.() ?? "");
  return names === undefined ? null : callNameIn(value, names, walk.table);
}
