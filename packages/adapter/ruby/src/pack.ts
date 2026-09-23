/**
 * The contract a Ruby pack implements.
 *
 * Each language adapter keeps its own pack contract until a second
 * implementation shows which parts can be shared. Anything a library
 * defines, such as its call names, keywords and scalars, comes in as pack
 * data. This package hardcodes none of it.
 */

import type { TypeShape } from "@suss/behavioral-ir";
import type { BodyBlockKind, BodyBlocks } from "./ast.js";
import type { ConstantPathConvention } from "./constantPath.js";
import type { GraphqlTypeNameConvention } from "./scope.js";

/** The inflections every pack in the run read from its project, pooled in the order the packs are listed. */
export function inflectionsIn(packs: readonly RubyPack[]): RbInflections {
  const pooled: RbInflections = {
    acronyms: [],
    irregular: [],
    uncountable: [],
    singular: [],
  };
  for (const pack of packs) {
    pooled.acronyms?.push(...(pack.inflections?.acronyms ?? []));
    pooled.irregular?.push(...(pack.inflections?.irregular ?? []));
    pooled.uncountable?.push(...(pack.inflections?.uncountable ?? []));
    pooled.singular?.push(...(pack.inflections?.singular ?? []));
  }
  return pooled;
}

/** Every body block the run's packs declare, pooled, with each optional flag defaulted to false. */
export function bodyBlocksIn(packs: readonly RubyPack[]): BodyBlocks {
  const pooled = new Map<string, BodyBlockKind>();
  for (const pack of packs) {
    for (const declared of pack.bodyBlocks ?? []) {
      pooled.set(declared.name, {
        moduleOnly: declared.moduleOnly ?? false,
        definesClassMethods: declared.definesClassMethods ?? false,
      });
    }
  }
  return pooled;
}

export interface RubyPack {
  name: string;
  /**
   * Part of the cache key. Bump it on any change that affects discovered
   * units or extracted summaries. The CLI also adds a hash of the loaded
   * pack file and its config to the key, so a pack run through the CLI
   * re-extracts after an edit even when it declares no version.
   */
  version?: string;
  /**
   * Files outside the walked `.rb` set whose content this pack reads,
   * given the files the run is about to walk. Their content goes into the
   * cache key, so editing one of them forces a re-extract.
   */
  discoveryInputs?: (files: readonly string[]) => string[];
  /** Wire protocol for the boundary bindings the pack produces, e.g. "http-graphql". */
  protocol: string;
  discovery: RubyDiscoveryPattern[];
  /** The calls the library offers a project for making a request. */
  clients?: RbClientCall[];
  /** The library's model calls that read or write the database. */
  storage?: RbStoragePattern[];
  /** The calls the library offers for sending the store a statement the project wrote itself. */
  rawSql?: RbRawSqlPattern[];
  /** Calls that read a model through a batching loader, where the model is an argument instead of the receiver. */
  loaders?: RbLoaderPattern[];
  /** Calls in a class or module body whose block runs as part of that body. */
  bodyBlocks?: RbBodyBlock[];
  /** Words and rules the project added to the library's inflector. They are tried before the adapter's defaults. */
  inflections?: RbInflections;
}

/**
 * The words and rules a project registered with its library's inflector.
 * Where a project writes them depends on the library, so the pack reads
 * them and passes the result here. The adapter applies them the same way
 * for every library.
 */
export interface RbInflections {
  /** Words a constant name keeps in capitals: with `API`, `api_token` becomes `APIToken`. */
  acronyms?: string[];
  /** A plural and the singular it comes from: `["people", "person"]`. */
  irregular?: Array<[plural: string, singular: string]>;
  /** Words spelled the same in both numbers. */
  uncountable?: string[];
  /** A rule turning a word singular, and what the part it matched becomes. A rule written `/body/flags` is a pattern; anything else is the text to replace. */
  singular?: Array<[rule: string, replacement: string]>;
}

/**
 * A receiverless call in a class or module body whose block runs as part
 * of that body, so what the block declares belongs to the class. Ruby has
 * no such call of its own. When no pack declares one, every block is read
 * as an ordinary block.
 */
export interface RbBodyBlock {
  /** The call as a project writes it, `included`. */
  name: string;
  /** Set when the library offers the call only to modules, as with a concern's `included`. */
  moduleOnly?: boolean;
  /** Set when a `def` in the block defines a method on the class itself instead of on an instance. */
  definesClassMethods?: boolean;
}

/**
 * The calls a library offers a project for making a request. A method
 * that makes one becomes a client unit, bound to the request method and
 * path of the call.
 */
export interface RbClientCall {
  /** The constant the calls are made on, as a project writes it: `Faraday`, `Net::HTTP`. */
  constantName: string;
  /** Method names that state the request method themselves: `get` means GET. */
  verbMethodNames: Record<string, string>;
  /** Where a call states the URL. */
  url: { position: number; keyword?: string };
  /** Methods on the constant that build a value taking the same calls, `new` for a Faraday connection. */
  receiverBuilders?: string[];
  /** The keyword a builder takes its base URL under. The base URL goes in front of the path of each call on the built value. */
  builderUrlKeyword?: string;
  /** The members of the response object, so a test on one of them counts as a test on the status. */
  response?: RbClientResponse;
  /** A call that sends a request object built separately. Net::HTTP sends any request with a body this way. */
  requestObject?: {
    /** The method that takes the request object, `request`. */
    attribute: string;
    /** Each request class, as a project writes it, and the method it sends: `Net::HTTP::Get` sends GET. */
    constructors: Record<string, string>;
    /** Where the request class takes the URL. */
    urlPosition: number;
  };
}

/**
 * The members of a library's response object. A test on one of them shows
 * which statuses the caller handles, and the checker compares that with
 * what the provider sends.
 */
export interface RbClientResponse {
  /** Members whose value is the status: `status` for Faraday, `code` for Net::HTTP. */
  statusCode?: string[];
  /** Members that say the request succeeded, meaning a status in 200 to 299: `success?`. */
  success?: string[];
  /** Members that give the body: `body`. */
  body?: string[];
  /** Whether a refused request comes back as a response or raises where it was made. */
  failureDelivery?: "response" | "exception";
}

/**
 * Ruby code declares no return types, so a call is matched by what its
 * receiver inherits from. A model is any class whose ancestry reaches one
 * of `baseClasses`, including through a base class the project declares
 * in between.
 *
 * `reads` and `writes` list every database call the library makes. A
 * method in neither list belongs to the project or the language, and the
 * reach walk follows it.
 */
export interface RbStoragePattern {
  /** Base classes the library provides for models, `ActiveRecord::Base` for Rails. */
  baseClasses: string[];
  /** Methods the library defines that change what is stored. */
  writes: string[];
  /** Methods the library defines that run a query. */
  reads: string[];
  /** Methods whose result is the model again: one record, or a relation a later read narrows to one. */
  givesBack: string[];
  /**
   * Methods on the model that take a statement the project wrote itself,
   * and where each one takes it. The tables come from the statement
   * instead of the model's own container, and the statement is read in
   * the dialect of `storageSystem`.
   */
  statements?: Record<string, RbArgumentPlace>;
  /** The token the library writes where a bind value goes, ActiveRecord's `?`. */
  bindPlaceholder?: string;
  /** The methods the library runs by itself around a write, as registered by `after_commit :sync_search`. */
  callbacks?: RbModelCallbacks;
  /** Methods that pick rows by the primary key when given a positional argument, and that key's column. */
  byPrimaryKey?: RbPrimaryKeyLookup;
  /** Read methods whose symbol arguments are the columns they ask for. */
  columnArguments?: string[];
  /** The calls a model uses to declare an association with another model, when the library has them. */
  associations?: RbAssociationCalls;
  /** Which database is behind the connection. The project decides this, so the pack passes it in. */
  storageSystem: "postgresql" | "mysql" | "sqlite";
}

/**
 * A library whose calls take SQL the project wrote, instead of building
 * it from a model. Ruby code declares no types, so the adapter finds the
 * receiver's type by following it back to the library call that produced
 * it. The chain starts at `constantName`, one of `clientBuilders` returns
 * a client, and `addressing` calls narrow that client to part of the store
 * before the statement or row call.
 */
export interface RbRawSqlPattern {
  /** The constant the library's calls start at, `PG` or `Google::Cloud::Bigquery`. */
  constantName: string;
  /**
   * Base classes whose subclasses return a client the same way the
   * constant does, `ActiveRecord::Base` for Rails. `Account.connection`
   * and a bare `connection` inside the model reach the same store as the
   * base class itself.
   */
  baseClasses?: string[];
  /** Methods on that constant that return a client, `connect` for the pg gem. */
  clientBuilders: string[];
  /** Calls that narrow a client to part of the store and return a value the later calls are made on. */
  addressing?: Record<string, RbAddressingCall>;
  /** Calls that take a statement, and where each one takes it. */
  statements?: Record<string, RbArgumentPlace>;
  /** The token the library writes where a bind value goes, when the dialect's parser does not read it. */
  bindPlaceholder?: string;
  /** Calls that read or write rows of an addressed container with no statement, `insert` on a BigQuery table. */
  rowCalls?: Record<string, RbRowCall>;
  /** Which store is behind the calls, in OpenTelemetry's semantic convention names: `postgresql`, `gcp.bigquery`. */
  storageSystem: string;
  /**
   * Which dialect the statements are written in. This can differ from the
   * store: BigQuery's store is `gcp.bigquery` and its dialect is
   * `bigquery`. There is no default, because a wrong dialect would read
   * the wrong tables without any warning.
   */
  dialect: string;
  /** The namespace the calls reach when neither the chain nor the table name gives one. Defaults to "default". */
  scope?: string;
}

/** A call that selects which part of the store the later calls reach, `bigquery.dataset("core")`. */
export interface RbAddressingCall extends RbArgumentPlace {
  /** Which part of the address this call gives. */
  says: "scope" | "container";
}

/** A call that reads or writes rows without a statement. */
export interface RbRowCall {
  kind: "read" | "write";
  /**
   * Where the call can take the container, for a library that offers the
   * same call on the container and one level above it: BigQuery's
   * `table.insert(rows)` and `dataset.insert("accounts", rows)`. When this
   * argument does not settle on a string, as with a rows argument, the
   * chain's own container is used.
   */
  container?: RbArgumentPlace;
}

/** Where a call takes one of its arguments. When a call passes it both ways, the keyword wins. */
export interface RbArgumentPlace {
  /** The index of the positional argument. */
  at: number;
  /** The keyword the argument can be passed under instead. */
  keyword?: string;
}

/**
 * The methods a model registers in its class body for the library to
 * run when a write happens. A body that writes through the model runs
 * them too, so their effects belong to that body.
 *
 * Both tables are keyed by the library's own event names: a write method
 * lists the events it fires, and a registering call lists the events it
 * covers.
 */
export interface RbModelCallbacks {
  /** Each write method the pattern declares, and the events it fires. */
  eventOf: Record<string, string[]>;
  /** Each class-body call that registers a callback, and the events it covers when the call does not narrow them. */
  registeredBy: Record<string, string[]>;
  /** The keyword that narrows one registration to some of those events, `on`. */
  eventKeyword: string;
}

/** Which methods take the primary key positionally, and what that column is called. */
export interface RbPrimaryKeyLookup {
  methods: string[];
  /** The column the library uses unless a model sets another. */
  column: string;
}

/**
 * The class-body calls a model uses to declare an association, and the
 * keyword that gives the target class. The calls are split into two
 * lists because a plural call's target is the singularised association
 * name, and a singular call's target is the name as written. Only the
 * library knows which of its calls is which.
 */
export interface RbAssociationCalls {
  /** Calls written in the singular, `belongs_to :account` and `has_one :profile`. */
  singular: string[];
  /** Calls written in the plural, `has_many :statuses`. */
  plural: string[];
  /** The keyword that gives the target class's name explicitly, `class_name`. */
  classNameKeyword: string;
}

/**
 * A loader that batches reads of a model for the caller, such as
 * graphql-ruby's dataloader. The call that picks what to load gets the
 * model as a constant argument, so the read is recorded against that
 * model as if the call were made on it. A storage pattern from another
 * pack in the run decides whether the constant is a model at all.
 */
export interface RbLoaderPattern {
  /** The receiverless call that returns the loader, `dataloader`. */
  loader: string;
  /** The method on the loader that picks a source and its arguments, `with`. */
  pick: string;
  /** The methods on a picked source that perform the read, `load` and `load_all`. */
  reads: string[];
  /** Receiverless calls that pick and read in one call, with the model among the arguments: `dataload` and `dataload_record`. */
  shortcuts: string[];
  /**
   * Where `pick` takes the project's own source class, and the method
   * the library runs on it. The read happens in that method, so whatever
   * it reaches is reported on every body that loads through it.
   */
  source?: RbLoaderSource;
}

/** The source class a loader is given, and the method the library runs on it. */
export interface RbLoaderSource {
  /** The position `pick` takes the source class at, 0 for `dataloader.with(Source, ...)`. */
  at: number;
  /** The method the library runs on the source, `fetch`. */
  method: string;
}

export type RubyDiscoveryPattern = GraphqlObjectFields | ControllerActions;

/**
 * A class whose ancestry reaches one of `baseClassNames` or
 * `ancestryRootClassNames` is a controller, and every instance method it
 * defines directly is an action. `routeFor` binds each action to the
 * method and path the project's routing gives it. An action `routeFor`
 * has no route for is still discovered, with no boundary binding.
 */
export interface ControllerActions {
  type: "controllerActions";
  /** Bases a project's controllers extend, such as `ApplicationController`. A base is not itself a controller. */
  baseClassNames: string[];
  /** The directory a bare superclass name is looked up under, which depends on the project's layout. */
  root: string;
  pathConvention: ConstantPathConvention;
  /** Acronyms the project registers with the inflector. The path convention keeps each one as one word: `ActivityPub` becomes `activitypub`. */
  acronyms?: string[];
  /** The library's own classes a project's controller chain ends at. A class extending one directly is a controller too. */
  ancestryRootClassNames: string[];
  /** The status a response gets when the action does not set one. */
  defaultStatusCode: number;
  /** The receiverless calls an action uses to send a status. Without them, every action reports the default. */
  responseStatusCalls?: RbStatusCall[];
  /** The number for each status name the library accepts in place of a number. For Rails this is Rack's symbol table. */
  statusCodeNames?: Record<string, number>;
  /**
   * Methods every controller inherits from the library, which for Rails
   * are `params`, `render` and the rest of what `ActionController` mixes
   * in. Nothing in the project defines them, so a receiverless call to
   * one is left off the action's effect list.
   */
  inheritedMethodNames?: string[];
  /** Absolute path of the routes file this pattern read, used in the gap `routingGaps` can report. */
  routesFile: string;
  /** The method and path the project's routing gives one controller action, or null when it has none. */
  routeFor: (
    controllerQualifiedName: string,
    actionName: string,
  ) => { method: string; path: string } | null;
  /** One message for each kind of routing declaration the pattern could not read. Calling it again returns the same list. */
  routingGaps?: () => readonly string[];
  /** The class-level calls that run one of the controller's own methods around its actions, Rails' `before_action` and `rescue_from`. */
  filters?: RbControllerFilter[];
}

/**
 * A class-body call that registers a method for the library to run around
 * a controller's actions. A class inherits what its ancestors register, so
 * a filter on `ApplicationController` applies to every action in the
 * project.
 */
export interface RbControllerFilter {
  /** The call as a controller writes it, `before_action`. */
  name: string;
  /**
   * Where the call takes the method: `argument` for the leading symbol
   * of `before_action :require_login`, `withKeyword` for the `with:` of
   * `rescue_from ActiveRecord::RecordNotFound, with: :not_found`.
   */
  methodFrom: "argument" | "withKeyword";
  /** Set when the library runs the method only for an action that raised, as `rescue_from` does. */
  onThrow?: boolean;
  /** The call that removes the filter again, `skip_before_action` for `before_action`. */
  skippedBy?: string;
  /** The keywords that limit a filter to some of the actions, Rails' `only` and `except`. */
  actionKeywords?: { include: string; exclude: string };
}

/**
 * A call an action makes to send a response, and where that call takes
 * the status. When a call passes the status both ways the keyword wins,
 * as in Rails for `head :ok, status: :created`.
 */
export interface RbStatusCall {
  /** The call's own name as an action writes it, `render` for Rails. */
  name: string;
  /** The keyword whose value gives the status, `status` for Rails. */
  statusKeyword?: string;
  /** The index of the positional argument giving the status, 0 for Rails' `head :no_content`. */
  statusArgument?: number;
  /**
   * The status this call sends when the action passes none. Rails'
   * `redirect_to` sends 302, while `render` sends the controller default,
   * so a default declared here takes precedence over `defaultStatusCode`.
   */
  defaultStatusCode?: number;
}

/** A class or module whose ancestry reaches one of `baseClassNames` declares GraphQL fields through DSL calls in its own body. */
export interface GraphqlObjectFields {
  type: "graphqlObjectFields";
  /** The base classes the library's generator writes. The walk follows a project's own intermediate bases, so config only needs to add a base with a different name. */
  baseClassNames: string[];
  /** The directory a wiring keyword's referenced class is looked up under, which depends on the project's layout. */
  root: string;
  pathConvention: ConstantPathConvention;
  /** Acronyms the project registers with the inflector. The path convention keeps each one as one word. */
  acronyms?: string[];
  /** The DSL call declaring one schema field in an object type's body. */
  fieldCallName: string;
  /** The DSL call declaring a referenced class's own return type. */
  typeCallName: string;
  argumentCallName: string;
  /** Keywords whose value is a class to read the declared contract from, one hop away. They are tried in the order listed. */
  wiringKeywords: string[];
  /** The method a wired class defines to resolve the field it is wired to. */
  resolverMethodName: string;
  /** The library's own classes that a project's class chain ends at. */
  ancestryRootClassNames: string[];
  /** The keyword on an argument call that says whether the argument is required. */
  requiredKeyword: string;
  /** Whether an argument is required when its call does not pass the required keyword. */
  requiredDefault: boolean;
  /** The keyword that overrides `camelizeDefault` for a single name. */
  camelizeKeyword: string;
  /** Whether a snake_case symbol is exposed in camelCase when the call does not say. */
  camelizeDefault: boolean;
  /** The scalar names the library accepts in a type position, and the shape of each. List only the library's own. */
  scalars: Record<string, TypeShape>;
  /** Module prefixes a project can write in front of those scalar names when it spells out the full path. */
  scalarNamePrefixes: string[];
  typeNameConvention: GraphqlTypeNameConvention;
  /**
   * A base class that changes a mutation's wire contract. When a wired
   * class's ancestry reaches `ancestorClassName`, the library wraps every
   * declared argument into one input-object argument called
   * `argumentName` and adds `extraFields` to it. graphql-ruby's
   * RelayClassicMutation does this: on the wire the mutation takes a
   * single required `input`, whose fields are the declared arguments plus
   * an optional `clientMutationId`.
   */
  argumentWrapping?: {
    ancestorClassName: string;
    argumentName: string;
    extraFields: Record<string, { type: TypeShape; required: boolean }>;
  };
}
