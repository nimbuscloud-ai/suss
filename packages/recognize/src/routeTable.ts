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

import { joinMountedPath } from "@suss/resolution";

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
  MountRole,
  PairArg,
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
  MountRole,
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

type Walked = EntrySource | UnreadItem;

/** An entry's children, and the list they are the entries of, so a list inside itself stops. */
interface Children {
  readonly entries: readonly Walked[];
  readonly list: string | null;
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
  /** Whether an enclosing entry's own path did not read, so no path inside it is claimed. */
  readonly pathUnread: boolean;
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
  pathUnread: false,
};

const NO_KEYS = (): undefined => undefined;

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
 * as an entry. The file's text is asked first, since stating a file's
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
  const names = module.importedNames(table.from);
  const read = new Set([
    ...Object.keys(table.roles),
    ...Object.keys(table.roots.kinds),
  ]);
  return [...names.values()].some((name) => read.has(name)) ? names : null;
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
  if (kind === null || !Object.hasOwn(rule.kinds, kind)) {
    return null;
  }
  const owner = ownerWritten(call, rule);
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
 * `Rails.application`, or "" for a root called bare. Null when the call
 * is not made where the rule says.
 */
function ownerWritten(
  call: CallOps,
  rule: RouteTableDeclaration["roots"],
): string | null {
  if (rule.calledOn === undefined) {
    return hasReceiver(call) ? null : "";
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
 * one of them, and null for any other call.
 */
function callName(call: CallOps, walk: Walk): string | null {
  if (walk.table.from === undefined) {
    return nameOf(call);
  }
  return hasReceiver(call) ? null : (walk.names.get(nameOf(call)) ?? null);
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

function joinTablePath(walk: Walk, prefix: string, segment: string): string {
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

/** Walks an entry's children, with the list they are the entries of open while they are walked. */
function walkChildren(children: Children, scope: Scope, walk: Walk): void {
  if (children.list !== null) {
    walk.opened.push(children.list);
  }
  walkEntries(children.entries, scope, walk);
  if (children.list !== null) {
    walk.opened.pop();
  }
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
      const read = ROLE_READERS[role.role] as RoleReader<RouteRole>;
      read(role, entry, scope, walk);
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
  if ("value" in role.handler) {
    readServesValue(role, role.handler.value, entry, scope, walk);
    return;
  }
  for (const method of methodsOf(role, entry.args, scope, walk)) {
    serveAt(role, role.handler, entry.args, scope, walk, method);
  }
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
  if (scope.pathUnread || own.kind === "unread") {
    return { ...scope, pathUnread: true };
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
  if (scope.pathUnread || own.kind === "unread") {
    walk.outcomes.push({
      kind: "unread",
      reason: scope.pathUnread ? "prefixUnread" : "pathUnread",
      handler,
      entry: entry.source,
    });
    return;
  }
  const path =
    own.kind === "segment"
      ? joinTablePath(walk, scope.pathPrefix, own.segment)
      : scope.pathPrefix || "/";
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

function methodsOf(
  role: ServesRole,
  args: EntryArgs,
  scope: Scope,
  walk: Walk,
): readonly string[] {
  if (Array.isArray(role.methods)) {
    return role.methods.flatMap((method) => aliased(walk.table, method));
  }
  const { pick, all } = role.methods as {
    readonly pick: EntryPick;
    readonly all?: string;
  };
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
