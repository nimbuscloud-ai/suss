/**
 * The words a pack declares a route table with, and what the composer in
 * `@suss/recognize` gives back. They are here, beside the other discovery
 * patterns, so a discovery pattern can contain a table and a pack depends
 * on this package alone. `@suss/recognize` composes the routes and
 * re-exports every name.
 *
 * A table's entries are calls, as Rails writes `get "/x"`, JSX elements,
 * as React Router writes `<Route path element>`, or objects in a list,
 * as `createBrowserRouter([{ path, element }])` writes them.
 */

import type { CallOps, ModuleOps, ValueOps } from "./ops.js";

/** What a route table's entries are called and what each one does, as one library writes them. */
export interface RouteTableDeclaration {
  /** Where a table starts in a file. */
  readonly roots: RootRule;
  /** What each entry does, by the name the entry is written with. */
  readonly roles: Readonly<Record<string, RouteRole>>;
  /**
   * How a handler splits into a controller key and an action, and how a
   * namespace joins onto a key. Unset for a table whose handlers are
   * values, which no role reads as a name.
   */
  readonly handler?: {
    readonly separator: string;
    readonly namespaceJoin: string;
  };
  /** The loop methods whose block runs once per element of a literal list, replayed with the element bound. */
  readonly loops: readonly string[];
  /** A method in an expansion's row that the table serves under several, such as `update` under PATCH and PUT. */
  readonly methodAliases?: Readonly<Record<string, readonly string[]>>;
  /** The role an object written as an item of a list is read as. Unset reads only calls there. */
  readonly objects?: string;
  /**
   * The modules a root call's name and an element's tag are imported from.
   * Each is read as the name the module exports it under, and a file that
   * imports none of the table's names has no table. Unset matches names as
   * the source writes them.
   */
  readonly from?: readonly string[];
  /**
   * How a nested path written with a leading `/` reads: joined under the
   * scope, as Rails reads `scope "/api" do get "/x"`, or on its own, as
   * React Router requires a nested absolute path to repeat its parent's.
   */
  readonly absolutePaths?: "join" | "standAlone";
  /**
   * Calls that turn elements into entries, such as React Router's
   * `createRoutesFromElements`. A list pick that reads one reads nothing,
   * since those elements are read where they are written.
   */
  readonly elementLists?: readonly string[];
  /**
   * How a path goes after the prefix in front of it, for a library that
   * puts the two together as strings: `asWritten` writes one after the
   * other, as FastAPI does, and `merged` then merges repeated slashes, as
   * Werkzeug serves a flask-restx path. Unset joins with one slash, or
   * the way `absolutePaths` says.
   */
  readonly joins?: "asWritten" | "merged";
  /**
   * Whether a decorator written as a call to a project function counts as
   * the library call that function returns, `@api_route("/x")` where
   * `api_route(path)` returns `ns.route(path)`, read with the decorator's
   * own arguments. It counts only when the function hands the library its
   * parameters in order, as `CallOps.returnedCall` says.
   */
  readonly throughWrappers?: boolean;
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
  /**
   * Where root calls are read: the calls the module body runs, the
   * default, or every call the file writes, inside functions too.
   */
  readonly in?: "moduleBody" | "file";
  /** Whether every element of the file that no element written with children encloses is a root too, walked in place. */
  readonly elements?: boolean;
  /**
   * Leave out a root built in a function that drops it, as
   * `CallOps.dropped` says, since nothing registered on it can serve a
   * request. The methods it may be called with are the roles' and
   * `owned`, the library's own registrations that are no role.
   */
  readonly unlessDropped?: { readonly owned: readonly string[] };
  /**
   * Where a root states a path in front of every route under it, as
   * flask-restx's `Api(prefix=)` does, read the way `noValue` says. A
   * path that does not read leaves every route under the root unread.
   */
  readonly path?: readonly EntryPick[];
  /** What a path written as no value means at the root, as `ScopesRole.noValue` says. Unset reads it as `unreadable`. */
  readonly noValue?: "unstated" | "unreadable";
  /** The value a root is built within, whose path goes in front of the root's own. */
  readonly carrier?: CarrierRule;
}

/**
 * The value a root is built within, such as the Flask blueprint that
 * flask-restx's `Api(bp)` is built from, whose path goes in front of the
 * root's. The root is handed it where it is built, or later through a
 * method called on it, as `api.init_app(bp)` does. A carrier is read for
 * its path alone, so one registered somewhere its own path no longer
 * says leaves every route under the root unread: a registration that
 * states a path, one made on another carrier, or a second registration.
 */
export interface CarrierRule {
  /** Where the root's construction, and a hand-off, states the carrier. */
  readonly at: EntryPick;
  /** The method called on a root that hands it a carrier after it is built. */
  readonly handedBy?: string;
  /** The modules a carrier's construction is imported from. A carrier built by anything else is one the table cannot follow. */
  readonly from: readonly string[];
  /**
   * Where each construction with a path of its own states it, by the
   * name its module exports it under. Any other construction from those
   * modules, such as the app itself, puts no path in front.
   */
  readonly paths: Readonly<Record<string, readonly EntryPick[]>>;
  /** What a path written as no value means, as `ScopesRole.noValue` says. Unset reads it as `unreadable`. */
  readonly noValue?: "unstated" | "unreadable";
  /** The method that registers a carrier, where it states the carrier, and where it states a path of its own. */
  readonly registeredBy?: {
    readonly method: string;
    readonly at: EntryPick;
    readonly path: readonly EntryPick[];
  };
}

/**
 * Where an entry's children are written: in its block, in the body of the
 * function it is handed at a position, as the entries of a list it is
 * handed, or as the elements written inside it. `chain` is for a builder
 * written as a chain of calls, and has no reader yet.
 *
 * `receiver` is for an entry that builds a value, such as `APIRouter()`:
 * its children are the calls made on that value anywhere in the files
 * read, each whose receiver comes to the call the entry is and whose
 * method a role has. A serves role whose handler is decorated takes only
 * the decorators written as such a call, so a dictionary's `.get(...)`
 * is never an entry.
 */
export type ChildrenIn =
  | { readonly in: "block" }
  | { readonly in: "callback"; readonly at: number }
  | { readonly in: "list"; readonly pick: EntryPick }
  | { readonly in: "elements" }
  | { readonly in: "chain" }
  | { readonly in: "receiver" };

/**
 * One value an entry states: by position, by keyword, as the key or the
 * value of a pair argument, or under a key: an element's attribute or an
 * object's own property.
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
   * serves every method, which the table writes as `*`. An entry that
   * passes nothing at the pick serves the `unstated` methods, as
   * FastAPI's `api_route` serves GET. Under `members`, a decorated class
   * serves one route for each method it writes whose name the list has,
   * upper-cased, with that method as the handler.
   */
  readonly methods:
    | readonly string[]
    | {
        readonly pick: EntryPick;
        readonly all?: string;
        readonly unstated?: readonly string[];
      }
    | { readonly members: readonly string[] };
  /** Where the path is, tried in order, or the scope's own path for an entry such as `root`. */
  readonly path: readonly EntryPick[] | { readonly fixed: "scope" };
  /**
   * Where the handler is, tried in order: a name written
   * `controller#action` with the table's separator, or, under `value`,
   * the value itself, handed back with the route, for a table whose
   * handler is a component rather than a name. Under `decorated`, the
   * handler is the function or class the entry is written over as a
   * decorator, and the entries are found as `ChildrenIn` `receiver` says.
   */
  readonly handler:
    | readonly EntryPick[]
    | { readonly value: readonly EntryPick[] }
    | { readonly decorated: true };
  /** A flag that, read true, has the entry serve the scope's own path when it states none. */
  readonly index?: EntryPick;
  /**
   * Where entries nested under this one are, tried in order, the first
   * that reads. They walk under this entry's path, and under the scope's
   * own when this entry states none.
   */
  readonly children?: readonly ChildrenIn[];
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
    /**
     * When the entry states no handler and no action, a path of two or
     * more words joined by `/`, and nothing else, says the handler
     * itself: the words before the last are the controller and the last
     * is the action, each with `wordRule` applied. The controller goes
     * under the scope's namespace. A path that ends with
     * `optionalSuffix` is read without it.
     */
    readonly handlerInPath?: { readonly optionalSuffix: string };
  };
  /** A flag that turns the format suffix off, when the pick reads `when`. */
  readonly formatless?: { readonly pick: EntryPick; readonly when: boolean };
}

/**
 * One route an expansion's row gives: its method, and its path, which is
 * the collection base and the suffix, or the member base where the
 * suffix starts with `{member}`.
 */
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
  /** The name the member segment and the nesting parameter take in place of `id`, such as `param: :username`. */
  readonly param?: EntryPick;
  /**
   * A flag that serves the member routes of an expansion with an id, and
   * of every one inside it, under the shallow path rather than under the
   * expansions around it. What is nested inside goes under the shallow
   * path too, and the collection routes stay where they are.
   */
  readonly shallow?: EntryPick;
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
  /** Whether the path segment also starts the shallow path, as `namespace` does and `scope` does not. */
  readonly shallowPath?: boolean;
  /**
   * What a path written as a value the library reads as none means: `""`,
   * `0`, `false`, or the language's literal for no value. `unstated`
   * reads it as no path, and `unreadable` evaluates it like any other
   * value, so only a string gives a path. Setting this reads the path the
   * way a library reads a router's prefix: one that does not read leaves
   * every route under the scope unread, where a scope that leaves it
   * unset, as Rails' `scope` does, adds no segment.
   */
  readonly noValue?: "unstated" | "unreadable";
  /** Whether the library trims trailing slashes off the path, as flask-restx trims a namespace's. Unset keeps them. */
  readonly trailingSlash?: "kept" | "trimmed";
  /** Whether the library makes up a path of its own where none is stated, so a route under a scope that states none is unread. */
  readonly prefixRequired?: boolean;
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

/**
 * An entry such as `mount X, at:` that serves another table under a
 * prefix, keyed under that table's namespace. With `prefix` set, the
 * table is a value the source built, such as `include_router(router)`,
 * and the call that built it is walked as an entry, through names and
 * fields. A `for` loop's variable is read as each item of its list.
 */
export interface MountRole {
  readonly role: "mount";
  /** Where the table is written, tried in order, read as the source writes it. */
  readonly table: readonly EntryPick[];
  readonly at: readonly EntryPick[];
  /**
   * How a path the mount states goes with the mounted value's own: in
   * front of it, as FastAPI's `include_router(prefix=)` does, or in
   * its place, as flask-restx's `add_namespace(path=)` does, which the
   * table does not follow, so routes under it are unread.
   */
  readonly prefix?: "inFront" | "replaces";
  /** What a path written as no value means at the mount, as `ScopesRole.noValue` says. Unset reads it as `unreadable`. */
  readonly noValue?: "unstated" | "unreadable";
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

/** An entry as the source writes it: a call, an element, or an object in a list. */
export type EntrySource =
  | { readonly form: "call"; readonly call: CallOps }
  | { readonly form: "element"; readonly value: ValueOps }
  | { readonly form: "object"; readonly value: ValueOps };

/**
 * Why an entry of a table whose handlers are values gave no route:
 *
 * - `pathUnread`: its own path does not read.
 * - `prefixUnread`: the path of an entry it is nested under does not read.
 * - `spread`: an item of a list spreads another collection into it.
 * - `notAnEntry`: an item of a list is written as something other than an object.
 * - `rootListUnread`: a root call's list is no list within reach.
 * - `listUnread`: an entry's children are no list within reach.
 */
export type RouteUnread =
  | "pathUnread"
  | "prefixUnread"
  | "spread"
  | "notAnEntry"
  | "rootListUnread"
  | "listUnread";

/** Why an entry found through a receiver, or a route under a mount of a value, gave no route. */
export type ReceiverUnread =
  /** No root's walk reaches the value the entry is made on: nothing mounts it, or it comes to no one value. */
  | "unreached"
  /** The same, while a loop the table cannot list mounts values that may include it. */
  | "unlistedLoop"
  /** A mount above it is in a function, and a loop elsewhere the table cannot list may mount it instead. */
  | "rivalledMount"
  /** A mount above it states a path that does not read. */
  | "mountUnread"
  /** A scope above it states no path, where its library makes one up. */
  | "prefixUnstated"
  /** A mount above it states a path that replaces the scope's own. */
  | "prefixReplaced"
  /** A mount above it leads back into a value the walk is already inside. */
  | "cycle"
  /** The path the root states does not read. */
  | "rootPrefixUnread"
  /** The root is handed more than one carrier. */
  | "carrierSeveral"
  /** The root's carrier comes to no construction from the carrier's modules. */
  | "carrierUnfollowed"
  /** The root's carrier is written as a name assigned more than one value. */
  | "carrierShared"
  /** The path the root's carrier states does not read. */
  | "carrierPrefixUnread"
  /** The root's carrier is registered with a path of the registration's own. */
  | "carrierRepathed"
  /** The root's carrier is registered on another carrier, which the table does not follow. */
  | "carrierNested"
  /** The root's carrier is registered more than once. */
  | "carrierRegisteredTwice";

/** One mount a walk went through on its way down from a root: the mount call, and the call that built the value it mounts. */
export interface MountHop {
  readonly call: CallOps;
  readonly value: CallOps;
}

/** What one entry of a table whose handlers are values came to, in the order the walk met it. */
export type RouteOutcome =
  | {
      readonly kind: "route";
      readonly method: string;
      readonly path: string;
      readonly handler: ValueOps;
      readonly entry: EntrySource;
      /** For a route a decorated class's method serves, the class. */
      readonly owner?: ValueOps;
      /** For an entry found through a receiver, the mounts from the root down to the value it is made on, outermost first. */
      readonly mounts?: readonly MountHop[];
      /** For a decorated entry, the path in front of its own, so a reader that reads the entry's path its own way can serve it. */
      readonly prefix?: string;
      /** For a decorator written as a call to a project wrapper, the library call the wrapper returns. */
      readonly made?: CallOps;
    }
  | {
      readonly kind: "unread";
      readonly reason: "pathUnread" | "prefixUnread" | ReceiverUnread;
      readonly handler: ValueOps;
      readonly entry: EntrySource;
      /** For a decorated entry, the method it would serve, one outcome for each. */
      readonly method?: string;
      /** For a route a decorated class's method serves, the class. */
      readonly owner?: ValueOps;
      /** For `unlistedLoop` and `rivalledMount`, each mount written in a loop the table cannot list that may mount it. */
      readonly loops?: readonly CallOps[];
      /** For an entry found through a receiver, the mounts from the root down to the value it is made on, outermost first. */
      readonly mounts?: readonly MountHop[];
      /** For a decorated entry whose own path is what did not read, the path in front of it. */
      readonly prefix?: string;
      /** For a decorator written as a call to a project wrapper, the library call the wrapper returns. */
      readonly made?: CallOps;
      /** For an entry found through a receiver, the call that built the value it is made on, when its receiver comes to one. */
      readonly on?: CallOps;
      /** For `unreached`, set when the receiver is written as more than one value, so no one of them is the one the entry is made on. */
      readonly shared?: true;
      /**
       * The value the reason is about, for a reader that says which one:
       * the scope whose path did not read, the value a mount that did not
       * read or that a loop rivals mounts, the value a cycle leads back
       * into, the root for a reason about the root or its carrier, and
       * for `unreached`, the value a mount no walk reached mounts it onto. An entry no walk reached has no mounts, so a
       * reason about a value other than `on` is about the value it is
       * mounted onto.
       */
      readonly router?: CallOps;
    }
  | {
      readonly kind: "unread";
      readonly reason: Exclude<RouteUnread, "pathUnread" | "prefixUnread">;
      /** The value that did not read: the spread's collection, the item, or the list. */
      readonly value: ValueOps;
      /** Where to say so: the root call whose list did not read, or the value itself. */
      readonly at: { readonly call: CallOps } | { readonly value: ValueOps };
    };

export interface RouteSet {
  /** Every distinct route that reaches the action, in the order the table declares them. */
  routesFor(controllerKey: string, action: string): readonly TableRoute[];
  /** The entries left unread, in the order the walk met them. */
  readonly gaps: readonly RouteGap[];
  /** Each route an entry whose handler is a value serves, and each such entry or list item left unread, in walk order. */
  readonly outcomes: readonly RouteOutcome[];
}
