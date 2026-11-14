/**
 * A route table a library writes apart from the handlers it routes to,
 * such as Rails' `config/routes.rb`, read into the routes each handler
 * serves.
 *
 * A pack states what each entry of the table is called and what it does,
 * as a role: it serves a method at a path, expands to a fixed set of
 * routes, opens a scope its children inherit, replays a fragment, includes
 * another file, or mounts another table. `composeRoutes` walks the entries
 * through the module ops with the scope passed down, and gives back every
 * route with the entries it could not read. Which files to read and which
 * table an owner is stay with the pack, because they need the file system
 * and the pack's own configuration.
 */

import { joinMountedPath } from "@suss/resolution";

import type { CallOps, ModuleOps, PairArg, ValueOps } from "@suss/extractor";

/** What a route table's entries are called and what each one does, as one library writes them. */
export interface RouteTableDeclaration {
  /** Where a table starts in a file. */
  readonly roots: RootRule;
  /** What each entry does, by the name the entry is written with. */
  readonly roles: Readonly<Record<string, RouteRole>>;
  /** How a handler splits into a controller key and an action, and how a namespace joins onto a key. */
  readonly handler: {
    readonly separator: string;
    readonly namespaceJoin: string;
  };
  /** The loop methods whose block runs once per element of a literal list, replayed with the element bound. */
  readonly loops: readonly string[];
  /** A method in an expansion's row that the table serves under several, such as `update` under PATCH and PUT. */
  readonly methodAliases?: Readonly<Record<string, readonly string[]>>;
}

/** The calls a table starts from, such as `<owner>.routes.draw do`, and the order each kind runs in. */
export interface RootRule {
  /** The method the root call is made on, `routes`, whose receiver is the owner. Unset for a root called bare. */
  readonly calledOn?: string;
  /** Each root method and its run order: `{ prepend: 0, draw: 1, append: 2 }`. */
  readonly kinds: Readonly<Record<string, number>>;
  /**
   * Where the root's entries are. An entry with no role, such as a loop
   * or a library's own wrapper, has its children in the same place.
   */
  readonly children: ChildrenIn;
}

/**
 * Where an entry's children are written: in its block, in the body of the
 * function it is handed at a position, or as the calls in a list it is
 * handed. `chain` is for a builder written as a chain of calls, and
 * has no reader yet.
 */
export type ChildrenIn =
  | { readonly in: "block" }
  | { readonly in: "callback"; readonly at: number }
  | { readonly in: "list"; readonly pick: EntryPick }
  | { readonly in: "chain" };

/**
 * One value an entry states: by position, by keyword, as the key or the
 * value of a pair argument, or under a key of an object entry. `key` is
 * for an entry written as an object, and has no reader yet.
 */
export type EntryPick =
  | { readonly at: number }
  | { readonly keyword: string }
  | { readonly pair: "key" | "value" }
  | { readonly key: string };

export type RouteRole =
  | ServesRole
  | ExpandsRole
  | ScopesRole
  | BaseRole
  | DefaultsRole
  | FragmentRole
  | ReplayRole
  | IncludeRole
  | MountRole;

/** An entry that serves one or more methods at a path. */
export interface ServesRole {
  readonly role: "serves";
  /**
   * The methods, fixed by the entry's name or read from a pick. A picked
   * list is upper-cased, and when it has the word `all` gives, the entry
   * serves every method, which the table writes as `*`.
   */
  readonly methods:
    | readonly string[]
    | { readonly pick: EntryPick; readonly all?: string };
  /** Where the path is, tried in order, or the scope's own path for an entry such as `root`. */
  readonly path: readonly EntryPick[] | { readonly fixed: "scope" };
  /** Where the handler is, tried in order, written `controller#action` with the table's separator. */
  readonly handler: readonly EntryPick[];
  /**
   * What an entry means when it states no handler: the path is `path`,
   * and the action is `action`, or else the path when it is one word, on
   * `controller` or the expansion's own controller. `on` says which of
   * the expansion's bases the path starts from, whether or not the entry
   * states a handler. A word is letters, digits, `_` and the character
   * `wordRule` replaces.
   */
  readonly bare?: {
    readonly path: EntryPick;
    readonly action: EntryPick;
    readonly controller: EntryPick;
    readonly on: EntryPick;
    readonly wordRule: { readonly replace: readonly [string, string] };
  };
  /** A flag that turns the format suffix off, when the pick reads `when`. */
  readonly formatless?: { readonly pick: EntryPick; readonly when: boolean };
}

/** One route an expansion's row gives: its method, and what follows the base, with `{id}` for the member segment. */
export interface ExpansionRow {
  readonly method: string;
  readonly suffix: string;
}

/** An entry read as a fixed list of rows under a base, such as `resources` and `resource`. */
export interface ExpandsRole {
  readonly role: "expands";
  readonly name: EntryPick;
  /** Each action and the routes it gives, in the order the table serves them. */
  readonly rows: Readonly<Record<string, readonly ExpansionRow[]>>;
  readonly only?: EntryPick;
  readonly except?: EntryPick;
  readonly controller?: EntryPick;
  readonly path?: EntryPick;
  readonly module?: EntryPick;
  /** Fragments replayed inside the expansion before its children. */
  readonly concerns?: EntryPick;
  /** How the controller is named from the entry's name: as written, or pluralized. */
  readonly controllerNaming: "asWritten" | "plural";
  /** Where an expansion nested inside goes: under `:{singular}_id` after the base, or under the base itself. */
  readonly nested: "singularId" | "self";
  /** The member base: the base and `:id`, or the base itself. */
  readonly member: "id" | "self";
  readonly children: ChildrenIn;
}

/**
 * A block that adds a path segment, a namespace segment, both, or
 * neither. One that adds neither leaves the scope as it is, inside an
 * expansion too; any other leaves the expansion and continues from where
 * a nested one would go.
 */
export interface ScopesRole {
  readonly role: "scopes";
  readonly path?: readonly EntryPick[];
  readonly namespace?: readonly EntryPick[];
  /** One word for both, as `namespace :admin` writes it. The scope opens only when it reads. */
  readonly both?: EntryPick;
  readonly children: ChildrenIn;
}

/** A block such as `member do` that chooses the base an entry inside an expansion starts from. */
export interface BaseRole {
  readonly role: "base";
  readonly which: "member" | "collection";
  readonly children: ChildrenIn;
}

/** A block such as `with_options k: v do` whose keywords every entry inside takes when it leaves them out. */
export interface DefaultsRole {
  readonly role: "defaults";
  readonly children: ChildrenIn;
}

/** A named fragment, such as `concern :name do`, that a replay writes again in its own scope. */
export interface FragmentRole {
  readonly role: "fragment";
  readonly name: EntryPick;
  readonly children: ChildrenIn;
}

/** An entry that replays the fragments its positional arguments name, from position `from` on. */
export interface ReplayRole {
  readonly role: "replay";
  readonly names: { readonly from: number };
}

/** An entry such as `draw(:name)` that reads another file's entries in place. */
export interface IncludeRole {
  readonly role: "include";
  readonly name: EntryPick;
}

/** An entry such as `mount X, at:` that serves another table under a prefix, keyed under that table's namespace. */
export interface MountRole {
  readonly role: "mount";
  /** Where the table is written, tried in order, read as the source writes it. */
  readonly table: readonly EntryPick[];
  readonly at: readonly EntryPick[];
}

/** Which table a root or a mount refers to. */
export type TableOwner =
  | { readonly table: "app" }
  | {
      readonly table: "mounted";
      readonly name: string;
      readonly namespace: string;
    };

export interface RouteSources {
  /** The files that may write roots, in the order their roots run, each with the path a gap message prints for it. */
  readonly files: readonly {
    readonly module: ModuleOps;
    readonly displayPath: string;
  }[];
  /** The table an owner refers to, as a root's receiver or a mount writes it, or null for neither. */
  readonly ownerOf: (owner: string) => TableOwner | null;
  /** The file an include reads by name, or null when there is none. */
  readonly include: (name: string) => ModuleOps | null;
  /** How the library inflects an expansion's name, for its controller and its nesting parameter. */
  readonly naming: {
    readonly singular: (word: string) => string;
    readonly plural: (word: string) => string;
  };
}

export interface TableRoute {
  readonly method: string;
  readonly path: string;
  /** Set for a route whose format suffix is turned off. */
  readonly formatless?: true;
}

export type RouteGap =
  | { readonly kind: "unread"; readonly file: string; readonly name: string }
  | {
      readonly kind: "walkedBlock";
      readonly file: string;
      readonly name: string;
    }
  | {
      readonly kind: "missingInclude";
      readonly file: string;
      readonly name: string;
    };

export interface RouteSet {
  /** Every distinct route that reaches the action, in the order the table declares them. */
  routesFor(controllerKey: string, action: string): readonly TableRoute[];
  /** The entries left unread, in the order the walk met them. */
  readonly gaps: readonly RouteGap[];
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
}

/** A call's arguments, as the picks read them. */
interface EntryArgs {
  readonly positional: readonly ValueOps[];
  readonly keyword: Readonly<Record<string, ValueOps>>;
  /** The last pair whose key is a value rather than a keyword. */
  readonly pair: PairArg | null;
}

interface Entry {
  readonly call: CallOps;
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
  readonly fragments: Map<string, readonly CallOps[]>;
  /** Names an include has read, so a file that includes itself stops. */
  readonly included: Set<string>;
  /** The first root of each mounted table, by the table's name. */
  readonly mounted: Map<string, Root>;
  /** Tables being walked under a mount, so a table that mounts itself stops. */
  readonly mounting: Set<string>;
  /** The file a gap is attributed to. */
  file: string;
}

interface Root {
  readonly kind: string;
  readonly children: readonly CallOps[];
  readonly displayPath: string;
}

const EMPTY_SCOPE: Scope = {
  pathPrefix: "",
  namespace: "",
  defaults: {},
  bindings: new Map(),
};

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
    fragments: new Map(),
    included: new Set(),
    mounted: new Map(),
    mounting: new Set(),
    file: "",
  };
  const appRoots: Root[] = [];
  for (const { module, displayPath } of sources.files) {
    for (const { owner, root } of rootsIn(module, displayPath, table)) {
      collectRoot(walk, appRoots, sources.ownerOf(owner), root);
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
    inFile(walk, root.displayPath, () => {
      walkEntries(root.children, EMPTY_SCOPE, walk);
    });
  }
  return {
    routesFor: (controllerKey, action) =>
      walk.routes.get(controllerKey)?.get(action) ?? [],
    gaps: walk.gaps,
  };
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
 * Every root the file writes outside a method: among the calls of its
 * body, or among the children of a call there, however deep, since a
 * library's hook such as `after_initialize do` can hold one.
 */
function rootsIn(
  module: ModuleOps,
  displayPath: string,
  table: RouteTableDeclaration,
): { owner: string; root: Root }[] {
  const found: { owner: string; root: Root }[] = [];
  const visit = (call: CallOps): void => {
    const root = asRoot(call, displayPath, table.roots);
    if (root !== null) {
      found.push(root);
      return;
    }
    for (const inner of childrenOf(call, table.roots.children, null) ?? []) {
      visit(inner);
    }
  };
  for (const call of module.calls()) {
    visit(call);
  }
  return found;
}

function asRoot(
  call: CallOps,
  displayPath: string,
  rule: RootRule,
): { owner: string; root: Root } | null {
  const kind = nameOf(call);
  const owner = Object.hasOwn(rule.kinds, kind)
    ? ownerWritten(call, rule)
    : null;
  const children =
    owner === null ? null : childrenOf(call, rule.children, null);
  return owner === null || children === null
    ? null
    : { owner, root: { kind, children, displayPath } };
}

/**
 * The owner as the source writes it before `.<calledOn>`, such as
 * `Rails.application`, or "" for a root called bare. Null when the call
 * is not made where the rule says.
 */
function ownerWritten(call: CallOps, rule: RootRule): string | null {
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
  call: CallOps,
  rule: ChildrenIn,
  args: EntryArgs | null,
): readonly CallOps[] | null {
  const read = CHILDREN_READERS[rule.in] as (
    call: CallOps,
    rule: ChildrenIn,
    args: EntryArgs | null,
  ) => readonly CallOps[] | null;
  return read(call, rule, args);
}

const CHILDREN_READERS: {
  readonly [K in ChildrenIn["in"]]: (
    call: CallOps,
    rule: Extract<ChildrenIn, { in: K }>,
    args: EntryArgs | null,
  ) => readonly CallOps[] | null;
} = {
  block: (call) => {
    const block = call.block?.() ?? null;
    return block === null ? null : (block.bodyCalls?.() ?? []);
  },
  callback: (call, rule) => {
    const handed = positionalOf(call)[rule.at];
    return handed === undefined ? null : (handed.bodyCalls?.() ?? []);
  },
  list: (call, rule, args) => {
    const keywords = "keyword" in rule.pick ? [rule.pick.keyword] : [];
    const list = picked(args ?? argsOf(call, keywords, {}), rule.pick);
    return list === undefined
      ? null
      : list.items().flatMap((item) => item.asCall?.() ?? []);
  },
  chain: () => null,
};

function argsOf(
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
    : `${prefix}${walk.table.handler.namespaceJoin}${segment}`;
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

/** The routes one row of an expansion gives under `base`, one for each method its method is served under. */
export function rowRoutes(
  table: RouteTableDeclaration,
  row: ExpansionRow,
  base: string,
): TableRoute[] {
  return aliased(table, row.method).map((method) => ({
    method,
    path: `${base}${row.suffix.replace("{id}", MEMBER_SEGMENT)}`,
  }));
}

/**
 * Walks the entries a root, a block or a file writes, which the ops list
 * through the branches of a conditional, so an entry under
 * `if Rails.env.development?` is declared in the same scope as one
 * written outside it.
 */
function walkEntries(
  calls: readonly CallOps[],
  scope: Scope,
  walk: Walk,
): void {
  for (const call of calls) {
    if (hasReceiver(call)) {
      replayLiteralLoop(call, scope, walk);
      continue;
    }
    const name = nameOf(call);
    const role = Object.hasOwn(walk.table.roles, name)
      ? walk.table.roles[name]
      : undefined;
    if (role !== undefined) {
      const entry: Entry = {
        call,
        name,
        args: argsOf(call, walk.keywords, scope.defaults),
      };
      const read = ROLE_READERS[role.role] as RoleReader<RouteRole>;
      read(role, entry, scope, walk);
      continue;
    }
    const wrapped = childrenOf(call, walk.table.roots.children, null) ?? [];
    if (wrapsEntries(wrapped, walk)) {
      walk.gaps.push({ kind: "walkedBlock", file: walk.file, name });
      walkEntries(wrapped, scope, walk);
      continue;
    }
    walk.gaps.push({ kind: "unread", file: walk.file, name });
  }
}

/**
 * A library's own wrapper, such as `devise_scope :user do ... end`, has
 * entries the table knows inside and leaves their path and handler
 * alone. One with no such entry, such as `direct`, stays unread.
 */
function wrapsEntries(children: readonly CallOps[], walk: Walk): boolean {
  return children.some(
    (inner) =>
      !hasReceiver(inner) && Object.hasOwn(walk.table.roles, nameOf(inner)),
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
  const children = childrenOf(call, walk.table.roots.children, null);
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
    walkEntries(children, { ...scope, bindings }, walk);
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
  defaults: (role, entry, scope, walk) => {
    const children = childrenOf(entry.call, role.children, entry.args);
    if (children !== null) {
      walkEntries(children, { ...scope, defaults: entry.args.keyword }, walk);
    }
  },
  fragment: (role, entry, scope, walk) => {
    const name = pickedWord(entry.args, role.name, scope);
    const children = childrenOf(entry.call, role.children, entry.args);
    if (name !== null && children !== null) {
      walk.fragments.set(name, children);
    }
  },
  replay: (role, entry, scope, walk) => {
    const names = entry.args.positional
      .slice(role.names.from)
      .map((value) => wordOf(value, scope))
      .filter((name): name is string => name !== null);
    replayFragments(names, scope, walk);
  },
  include: readInclude,
  mount: readMount,
};

/** Walks each named fragment's children in the scope the replay is written in. */
function replayFragments(
  names: readonly string[],
  scope: Scope,
  walk: Walk,
): void {
  for (const name of names) {
    const children = walk.fragments.get(name);
    if (children !== undefined) {
      walkEntries(children, scope, walk);
    }
  }
}

function readServes(
  role: ServesRole,
  entry: Entry,
  scope: Scope,
  walk: Walk,
): void {
  for (const method of methodsOf(role, entry.args, scope, walk)) {
    serveAt(role, entry.args, scope, walk, method);
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
  const index = text.indexOf(walk.table.handler.separator);
  if (index === -1) {
    return null;
  }
  return {
    controllerKey: text.slice(0, index),
    action: text.slice(index + walk.table.handler.separator.length),
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
  args: EntryArgs,
  scope: Scope,
  walk: Walk,
  method: string,
): void {
  const handler = handlerOf(role.handler, args, scope, walk);
  if (!Array.isArray(role.path)) {
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
      : stated(handler, role.path as readonly EntryPick[], args, scope, walk);
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
  const base = joinRoutePath(
    scope.expansion?.nestedBase ?? scope.pathPrefix,
    pickedWord(args, role.path, scope) ?? name,
  );

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
      rowRoutes(walk.table, row, base),
    )) {
      addRoute(walk, controllerKey, action, route);
    }
  }

  // The nesting parameter comes from the entry's own name, whatever
  // `path:` said the URL reads.
  const nestedBase =
    role.nested === "singularId"
      ? `${base}/:${naming.singular(name)}_id`
      : base;
  const inside: Scope = {
    ...scope,
    namespace,
    expansion: {
      controllerKey,
      collectionBase: base,
      memberBase: role.member === "id" ? `${base}/${MEMBER_SEGMENT}` : base,
      nestedBase,
      ambientBase: nestedBase,
    },
  };
  replayFragments(namesOf(args, role.concerns, scope) ?? [], inside, walk);
  const children = childrenOf(entry.call, role.children, args);
  if (children !== null) {
    walkEntries(children, inside, walk);
  }
}

/** The segment a member route's id is written as. */
const MEMBER_SEGMENT = ":id";

function readScopes(
  role: ScopesRole,
  entry: Entry,
  scope: Scope,
  walk: Walk,
): void {
  const children = childrenOf(entry.call, role.children, entry.args);
  if (children === null) {
    return;
  }
  if (
    role.both === undefined &&
    role.path === undefined &&
    role.namespace === undefined
  ) {
    walkEntries(children, scope, walk);
    return;
  }
  const segments = scopeSegments(role, entry.args, scope);
  if (segments !== null) {
    walkEntries(children, enterScope(scope, segments, walk), walk);
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
  };
}

function readBase(
  role: BaseRole,
  entry: Entry,
  scope: Scope,
  walk: Walk,
): void {
  const expansion = scope.expansion;
  const children = childrenOf(entry.call, role.children, entry.args);
  if (expansion === undefined || children === null) {
    return;
  }
  const ambientBase =
    role.which === "member" ? expansion.memberBase : expansion.collectionBase;
  walkEntries(
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
  walkEntries(module.bodyCalls(), scope, walk);
}

/** The first pick that gives a value, read as the source writes it. */
function firstSource(
  args: EntryArgs,
  picks: readonly EntryPick[],
): string | null {
  for (const pick of picks) {
    const value = picked(args, pick);
    if (value !== undefined) {
      return value.source?.() ?? null;
    }
  }
  return null;
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
  inFile(walk, root.displayPath, () => {
    walkEntries(
      root.children,
      {
        ...EMPTY_SCOPE,
        pathPrefix: joinRoutePath(scope.pathPrefix, mountPath),
        namespace: owner.namespace,
      },
      walk,
    );
  });
  walk.mounting.delete(owner.name);
}
