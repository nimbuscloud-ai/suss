// @suss/client-axios: PatternPack for the axios HTTP client

import { z } from "zod";

import type { DiscoveryPattern, PatternPack } from "@suss/extractor";
import type { PackDeclaration } from "@suss/ir-core";

const HTTP_METHODS = [
  "get",
  "post",
  "put",
  "delete",
  "patch",
  "head",
  "options",
] as const;

/**
 * A function that builds an axios instance the way axios.create(...)
 * does, declared in a dependency stub rather than
 * shipped as a default. A project that wraps axios.create in its
 * own helper, to set shared defaults across every service, writes no
 * axios.create(...) call at its own use sites, only a call to the
 * helper, so the built-in factoryMethods entry never sees it.
 */
const clientFactory = z
  .object({
    /** Module specifier the factory function is imported from. */
    module: z.string(),
    /** Name the factory function is exported under. */
    export: z.string(),
  })
  .strict();

export type AxiosClientFactory = z.infer<typeof clientFactory>;

/**
 * What this pack's options may say. The CLI parses a
 * `-f axios=config.json` file against it, minus the keys a dependency
 * stub fills, which a config file may not set.
 */
export const optionsSchema = z
  .object({
    /**
     * Project functions this project builds axios instances through,
     * beyond the built-in axios.create. Each site importing one of
     * these and calling it is a client instance the same way an
     * axios.create() result is, wherever the call it delegates to
     * lives.
     */
    factories: z.array(clientFactory).optional(),
  })
  .strict();

export type AxiosPackOptions = z.infer<typeof optionsSchema>;

function discoveryForVerb(
  verb: (typeof HTTP_METHODS)[number],
  factories: AxiosClientFactory[],
): DiscoveryPattern[] {
  const patterns: DiscoveryPattern[] = [
    {
      // Matches both shapes:
      //   axios.<verb>("/path", ...)
      //   const api = axios.create({ ... }); api.<verb>("/path", ...)
      // The factoryMethods entry tells the adapter that variables initialized
      // from axios.create(...) are also clients, wherever that call and
      // this one turn out to live.
      kind: "client",
      match: {
        type: "clientCall",
        importModule: "axios",
        importName: "axios",
        methodFilter: [verb],
        factoryMethods: ["create"],
      },
      bindingExtraction: {
        method: { type: "literal", value: verb.toUpperCase() },
        path: { type: "fromArgument", position: 0 },
      },
      requiresImport: ["axios"],
    },
  ];

  // One pattern per configured factory. The factory itself stands in
  // for the "import" a plain clientCall pattern already knows how to
  // read, since calling it directly (const api = createApiClient())
  // is the same shape initClient(...)-style clients already match.
  for (const factory of factories) {
    patterns.push({
      kind: "client",
      match: {
        type: "clientCall",
        importModule: factory.module,
        importName: factory.export,
        methodFilter: [verb],
      },
      bindingExtraction: {
        method: { type: "literal", value: verb.toUpperCase() },
        path: { type: "fromArgument", position: 0 },
      },
      // A bare specifier gates the way "axios" above does: cheap and
      // exact, since two files spelling a package name the same way
      // mean the same package. A path-shaped module ("./apiClient")
      // points at a location relative to wherever it's written, and the
      // pre-filter only ever reads a file's own import text before
      // anything is parsed, so it has no way to tell "./apiClient"
      // and a consumer's "../apiClient" apart from string text alone.
      // Narrowing on that string would exclude the consumer roughly
      // as often as include it, so a path-shaped factory gives no
      // gate at all and every file is walked; the discovery layer
      // resolves the module correctly once it's reading a file's
      // imports against a parsed project.
      requiresImport: isPathShapedSpecifier(factory.module)
        ? []
        : [factory.module],
    });
  }

  return patterns;
}

/** A relative or absolute specifier points at a location rather than a package. */
function isPathShapedSpecifier(specifier: string): boolean {
  return specifier.startsWith(".") || specifier.startsWith("/");
}

/**
 * A request written as one config object: `axios({ url, method })`,
 * `api({ url })` on an instance, or `axios.request(config)`. The method
 * is whatever the object says, and GET when it says nothing, which is
 * what axios does with it.
 */
function configCallDiscovery(
  factories: AxiosClientFactory[],
): DiscoveryPattern[] {
  const bindingExtraction: DiscoveryPattern["bindingExtraction"] = {
    method: {
      type: "fromArgumentProperty",
      position: 0,
      property: "method",
      default: "GET",
    },
    path: { type: "fromArgumentProperty", position: 0, property: "url" },
  };
  const patterns: DiscoveryPattern[] = [
    {
      kind: "client",
      match: {
        type: "clientCall",
        importModule: "axios",
        importName: "axios",
        methodFilter: ["request"],
        factoryMethods: ["create"],
        callable: true,
      },
      bindingExtraction,
      requiresImport: ["axios"],
    },
  ];
  // Calling a declared factory builds a client rather than sending a
  // request, so only `.request(config)` is read on what it returns.
  for (const factory of factories) {
    patterns.push({
      kind: "client",
      match: {
        type: "clientCall",
        importModule: factory.module,
        importName: factory.export,
        methodFilter: ["request"],
      },
      bindingExtraction,
      requiresImport: isPathShapedSpecifier(factory.module)
        ? []
        : [factory.module],
    });
  }
  return patterns;
}

export function axiosPack(options: AxiosPackOptions = {}): PatternPack {
  const factories = options.factories ?? [];
  return {
    name: "axios",
    protocol: "http",
    languages: ["typescript", "javascript"],

    discovery: [
      ...HTTP_METHODS.flatMap((verb) => discoveryForVerb(verb, factories)),
      ...configCallDiscovery(factories),
    ],

    terminals: [
      {
        kind: "return",
        match: { type: "returnStatement" },
        extraction: {},
      },
      {
        kind: "throw",
        match: { type: "throwExpression" },
        extraction: {},
      },
    ],

    inputMapping: {
      type: "positionalParams",
      params: [],
    },

    responseSemantics: [
      // axios returns AxiosResponse: body lives on .data, not .body or .json()
      { name: "data", access: "property", semantics: { type: "body" } },
      { name: "status", access: "property", semantics: { type: "statusCode" } },
      { name: "headers", access: "property", semantics: { type: "headers" } },
    ],

    // A non-2xx rejects, so the caller never gets a response to read a
    // status off, and its catch is where every failure arrives.
    failureDelivery: "exception",
  };
}

/** What this pack reads, and what a project has to be using for it to. */
export const declares: PackDeclaration = {
  kind: "client",
  package: "@suss/client-axios",
  dependencies: [{ ecosystem: "npm", name: "axios" }],
  reads: "axios call sites + \`axios.create\` factories.",
};

export default axiosPack;
