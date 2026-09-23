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
 * A project function that builds an axios instance the way
 * axios.create(...) does, declared in a dependency stub. A project that
 * wraps axios.create in its own helper calls only the helper at its use
 * sites, so the built-in factoryMethods entry would miss those clients.
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
 * The options this pack accepts. The CLI checks a `-f axios=config.json`
 * file against it, except for the keys a dependency stub fills in, which
 * a config file may not set.
 */
export const optionsSchema = z
  .object({
    /**
     * Project functions that build axios instances, in addition to
     * axios.create. Calling one of these gives a client instance, the
     * same as an axios.create() result.
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
      // Matches `axios.<verb>(path)` and `api.<verb>(path)`. factoryMethods
      // makes a variable set from axios.create(...) a client too, even
      // when it is created in another file.
      kind: "client",
      match: {
        type: "clientCall",
        importModule: "axios",
        importName: "axios",
        methodFilter: [verb],
        factoryMethods: ["create"],
        basePathOption: "baseURL",
      },
      bindingExtraction: {
        method: { type: "literal", value: verb.toUpperCase() },
        path: { type: "fromArgument", position: 0 },
      },
      requiresImport: ["axios"],
    },
  ];

  // A configured factory is matched in place of the axios import, because
  // `const api = createApiClient()` returns a client the same way
  // axios.create does.
  for (const factory of factories) {
    patterns.push({
      kind: "client",
      match: {
        type: "clientCall",
        importModule: factory.module,
        importName: factory.export,
        methodFilter: [verb],
        basePathOption: "baseURL",
      },
      bindingExtraction: {
        method: { type: "literal", value: verb.toUpperCase() },
        path: { type: "fromArgument", position: 0 },
      },
      // Each importing file spells a relative path differently, so the
      // import-text prefilter cannot match one and a path-shaped factory
      // walks every file. The README has the details.
      requiresImport: isPathShapedSpecifier(factory.module)
        ? []
        : [factory.module],
    });
  }

  return patterns;
}

function isPathShapedSpecifier(specifier: string): boolean {
  return specifier.startsWith(".") || specifier.startsWith("/");
}

/**
 * A request written as one config object, as in `axios({ url, method })`
 * or `axios.request(config)`. The method defaults to GET, as in axios.
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
        basePathOption: "baseURL",
      },
      bindingExtraction,
      requiresImport: ["axios"],
    },
  ];
  // Calling a declared factory builds a client and sends nothing, so only
  // `.request(config)` on its result is matched.
  for (const factory of factories) {
    patterns.push({
      kind: "client",
      match: {
        type: "clientCall",
        importModule: factory.module,
        importName: factory.export,
        methodFilter: ["request"],
        basePathOption: "baseURL",
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
      // axios puts the parsed response body on `.data`.
      { name: "data", access: "property", semantics: { type: "body" } },
      { name: "status", access: "property", semantics: { type: "statusCode" } },
      { name: "headers", access: "property", semantics: { type: "headers" } },
    ],

    // axios rejects on a non-2xx status, so every failure reaches the
    // caller's catch block instead of coming back as a response.
    failureDelivery: "exception",
  };
}

/** What this pack reads, and what a project has to be using for it to. */
export const declares: PackDeclaration = {
  kind: "client",
  package: "@suss/client-axios",
  dependencies: [{ ecosystem: "npm", name: "axios" }],
  reads:
    "axios call sites, including calls on a client that \`axios.create\` made.",
};

export default axiosPack;
