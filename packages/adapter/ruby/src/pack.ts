/**
 * The Ruby adapter's own pattern-pack contract.
 *
 * Match shapes stay per-language until a second implementation shows what is
 * actually shared, so this is Ruby's own and not the TypeScript or Python
 * adapter's. Everything a library defines, meaning its call names, keywords,
 * scalars, and conventions, arrives as pack data and is never hardcoded here.
 */

import type { TypeShape } from "@suss/behavioral-ir";
import type { ConstantPathConvention } from "./constantPath.js";
import type { GraphqlTypeNameConvention } from "./scope.js";

export interface RubyPack {
  name: string;
  /**
   * Pack version stamp, which feeds the cache invalidation key. Bump on
   * any change that affects discovered units or extracted summaries.
   * The CLI folds a hash of the loaded pack file and its config into
   * this stamp on top, so a pack run through the CLI invalidates on an
   * edit whether or not it declares a version of its own.
   */
  version?: string;
  /**
   * Files under the project this pack reads that are not among the
   * `.rb` files a run walks, given the files the run is about to walk.
   * Their content feeds the same cache key the pack's own config does,
   * so an edit to one of them re-extracts instead of handing back the
   * previous answer.
   */
  discoveryInputs?: (files: readonly string[]) => string[];
  /** Wire protocol for the produced boundary bindings, e.g. "http-graphql". */
  protocol: string;
  discovery: RubyDiscoveryPattern[];
  /** The calls the library gives a project for making a request. */
  clients?: RbClientCall[];
  /** What the library's own database calls look like. The README says how one is matched. */
  storage?: RbStoragePattern[];
  /** Calls the library gives a project for reading a model through a batching loader, rather than on the model itself. */
  loaders?: RbLoaderPattern[];
}

/**
 * The calls a library gives a project for making a request. A method
 * that makes one is a client of the boundary that call states, and gets
 * a unit bound to its method and path.
 */
export interface RbClientCall {
  /** The constant the calls hang on, as a project writes it: `Faraday`, `Net::HTTP`. */
  constantName: string;
  /** Method names that state the request method themselves: `get` means GET. */
  verbMethodNames: Record<string, string>;
  /** Where a call states the URL. */
  url: { position: number; keyword?: string };
  /** Methods on the constant that build a value taking the same calls, `new` for a Faraday connection. */
  receiverBuilders?: string[];
  /** The keyword such a builder takes the base URL under, which comes in front of the path of a call on it. */
  builderUrlKeyword?: string;
  /** What the response object gives a caller, so a test on one of its members counts as a test on a status. */
  response?: RbClientResponse;
  /** A call that sends a request object built somewhere else, which is how Net::HTTP sends anything with a body. */
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
 * The members a library's response object gives a caller. A caller that
 * tests one of them is saying which statuses it handles, and the
 * checker compares that against what the other side produces.
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
 * Ruby writes no return type, so a call is matched by what its receiver
 * inherits from. A model is a class that reaches one of these base classes,
 * whether the project declares an intermediate one or not.
 */
export interface RbStoragePattern {
  /** Base classes the library gives a model, `ActiveRecord::Base` for Rails. */
  baseClasses: string[];
  /** Methods that change what is stored. Anything else reads. */
  writes: string[];
  /** Which database is behind the connection, which the project settles. */
  storageSystem: "postgresql" | "mysql" | "sqlite";
}

/**
 * A loader that batches reads of a model on the caller's behalf, graphql-ruby's
 * dataloader for one. The call that picks what to load is given the model as
 * a constant argument, so the read is recorded against that model the same
 * way a call on the model itself would be, and a storage pattern from another
 * pack in the run says whether the constant is a model at all.
 */
export interface RbLoaderPattern {
  /** The receiverless call that gives the loader, `dataloader`. */
  loader: string;
  /** The method on the loader that picks a source and its arguments, `with`. */
  pick: string;
  /** The methods on a picked source that perform the read, `load` and `load_all`. */
  reads: string[];
  /** Receiverless calls that pick and read in one, whose arguments include the model, `dataload` and `dataload_record`. */
  shortcuts: string[];
}

export type RubyDiscoveryPattern = GraphqlObjectFields | ControllerActions;

/** A class whose ancestry reaches one of `baseClassNames` or `ancestryRootClassNames` is a controller, and every instance method it defines directly is one of its actions, bound by `routeFor` to the method and path a project's own routing gives it, or discovered with no boundary binding when `routeFor` finds none. */
export interface ControllerActions {
  type: "controllerActions";
  /** A base a project's controllers extend, `ApplicationController` say. The base itself is not a controller. */
  baseClassNames: string[];
  /** The directory a bare superclass name is looked up under, the project's own layout. */
  root: string;
  pathConvention: ConstantPathConvention;
  /** Acronyms the project registers with the inflector, which the path convention keeps as one word: `ActivityPub` is `activitypub`, not `activity_pub`. */
  acronyms?: string[];
  /** The library's own classes a project's controller chain ends at. A class extending one directly is a controller too. */
  ancestryRootClassNames: string[];
  /** Status code a wire response gets when the action does not say otherwise. */
  defaultStatusCode: number;
  /** The receiverless calls the library gives an action for writing a wire status. Leave it out and every action reports the default. */
  responseStatusCalls?: RbStatusCall[];
  /** The number behind each name the library accepts where a status number could go, Rack's own symbol table for Rails. */
  statusCodeNames?: Record<string, number>;
  /**
   * The methods every controller gets without defining them, which for
   * Rails is `params`, `render` and the rest of what `ActionController`
   * mixes in. An action's effect list is there to show what the action
   * reaches in the project, and nothing in the project defines these,
   * so a receiverless call to one of them is left off that list.
   */
  inheritedMethodNames?: string[];
  /** Absolute path of the file this pattern's own routing came from, for the one gap `routingGaps` may report. */
  routesFile: string;
  /** The method and path a project's own routing gives one controller's action, or null when that action has none. */
  routeFor: (
    controllerQualifiedName: string,
    actionName: string,
  ) => { method: string; path: string } | null;
  /** One message per routing declaration kind this pattern's reading left uncovered. A pure read: calling it again gives the same list. */
  routingGaps?: () => readonly string[];
  /** The class-level calls the library gives a controller for running one of its own methods around every action, Rails' `before_action` and `rescue_from`. */
  filters?: RbControllerFilter[];
}

/**
 * A call in a controller's class body naming a method the library runs
 * around the action, and which actions that reaches. A class inherits
 * what its ancestors declared, so a filter on `ApplicationController`
 * reaches every action in the project.
 */
export interface RbControllerFilter {
  /** The call as a controller writes it, `before_action`. */
  name: string;
  /**
   * Where the call names the method: `argument` for the leading symbol
   * of `before_action :require_login`, `withKeyword` for the `with:` of
   * `rescue_from ActiveRecord::RecordNotFound, with: :not_found`.
   */
  methodFrom: "argument" | "withKeyword";
  /** Set when the library runs the method only for an action that raised, as `rescue_from` does. */
  onThrow?: boolean;
  /** The name of the call that takes a filter back off, `skip_before_action` for `before_action`. */
  skippedBy?: string;
  /** The keywords that narrow a filter to some of the actions, Rails' `only` and `except`. */
  actionKeywords?: { include: string; exclude: string };
}

/**
 * One call an action writes to send a response, and where that call takes
 * the status. A call may take it both ways, and then the keyword wins,
 * as it does in Rails for `head :ok, status: :created`.
 */
export interface RbStatusCall {
  /** The call's own name as an action writes it, `render` for Rails. */
  name: string;
  /** The keyword whose value gives the status, `status` for Rails. */
  statusKeyword?: string;
  /** The index of the positional argument giving the status, 0 for Rails' `head :no_content`. */
  statusArgument?: number;
  /**
   * The status this call sends when the action writes none. Rails'
   * `redirect_to` sends 302 where its `render` sends the controller's own
   * default, so a default declared here wins over `defaultStatusCode`.
   */
  defaultStatusCode?: number;
}

/** A class or module whose ancestry reaches one of `baseClassNames` declares GraphQL fields through DSL calls in its own body. */
export interface GraphqlObjectFields {
  type: "graphqlObjectFields";
  /** The base classes the library itself generates. The walk crosses a project's own intermediate bases on its own, so config only has to add a base with another name. */
  baseClassNames: string[];
  /** The directory a wiring keyword's referenced class is looked up under. That is the project's own layout, not the library's. */
  root: string;
  pathConvention: ConstantPathConvention;
  /** Acronyms the project registers with the inflector, which the path convention keeps as one word. */
  acronyms?: string[];
  /** The DSL call declaring one schema field in an object type's body. */
  fieldCallName: string;
  /** The DSL call declaring a referenced class's own return type. */
  typeCallName: string;
  argumentCallName: string;
  /** Keywords whose value gives a class to read the declared contract from, one hop away. They are tried in the order listed. */
  wiringKeywords: string[];
  /** The method a wired class defines to resolve the field it is wired to. Library-defined. */
  resolverMethodName: string;
  /** The library's own classes that a project's class chain ends at. Library-defined. */
  ancestryRootClassNames: string[];
  /** Keyword on an argument call saying whether the argument is required. Library-defined. */
  requiredKeyword: string;
  /** What an argument means when it does not write the required keyword at all. */
  requiredDefault: boolean;
  /** The keyword that overrides `camelizeDefault` for a single name. */
  camelizeKeyword: string;
  /** Whether a symbol's snake_case name is exposed camelCased when the call itself does not say. */
  camelizeDefault: boolean;
  /** Only the names the library itself accepts in a type position belong here. */
  scalars: Record<string, TypeShape>;
  /** Module prefixes the same scalars can also be written under when someone spells out the full path. */
  scalarNamePrefixes: string[];
  typeNameConvention: GraphqlTypeNameConvention;
  /**
   * A base class that changes a mutation's wire contract. When a wired
   * class's ancestry reaches `ancestorClassName`, the library wraps
   * every declared argument into one input-object argument called
   * `argumentName` and adds `extraFields` to it. graphql-ruby's
   * RelayClassicMutation is the class this describes: on the wire the
   * mutation takes a single required `input`, whose fields are the
   * declared arguments plus an optional `clientMutationId`.
   */
  argumentWrapping?: {
    ancestorClassName: string;
    argumentName: string;
    extraFields: Record<string, { type: TypeShape; required: boolean }>;
  };
}
