// @suss/client-axios — PatternPack for the axios HTTP client

import type { DiscoveryPattern, PatternPack } from "@suss/extractor";

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
 * axios.create(...) does, named through pack config rather than
 * shipped as a default. A project that wraps axios.create in its
 * own helper, to set shared defaults across every service, writes no
 * axios.create(...) call at its own use sites, only a call to the
 * helper, so the built-in factoryMethods entry never sees it.
 */
export interface AxiosClientFactory {
  /** Module specifier the factory function is imported from. */
  module: string;
  /** Name the factory function is exported under. */
  export: string;
}

export interface AxiosPackOptions {
  /**
   * Project functions this project builds axios instances through,
   * beyond the built-in axios.create. Each site importing one of
   * these and calling it is a client instance the same way an
   * axios.create() result is, wherever the call it delegates to
   * lives.
   */
  factories?: AxiosClientFactory[];
}

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
        path: { type: "fromArgumentLiteral", position: 0 },
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
        path: { type: "fromArgumentLiteral", position: 0 },
      },
      // A bare specifier gates the way "axios" above does: cheap and
      // exact, since two files spelling a package name the same way
      // mean the same package. A path-shaped module ("./apiClient")
      // names a location relative to wherever it's written, and the
      // pre-filter only ever reads a file's own import text before
      // anything is parsed, so it has no way to tell "./apiClient"
      // and a consumer's "../apiClient" apart from string text alone.
      // Narrowing on that string would exclude the consumer roughly
      // as often as include it, so a path-shaped factory carries no
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

/** A relative or absolute specifier names a location, not a package. */
function isPathShapedSpecifier(specifier: string): boolean {
  return specifier.startsWith(".") || specifier.startsWith("/");
}

export function axiosPack(options: AxiosPackOptions = {}): PatternPack {
  const factories = options.factories ?? [];
  return {
    name: "axios",
    protocol: "http",
    languages: ["typescript", "javascript"],

    discovery: HTTP_METHODS.flatMap((verb) =>
      discoveryForVerb(verb, factories),
    ),

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
      // axios returns AxiosResponse — body lives on .data, not .body or .json()
      { name: "data", access: "property", semantics: { type: "body" } },
      { name: "status", access: "property", semantics: { type: "statusCode" } },
      { name: "headers", access: "property", semantics: { type: "headers" } },
    ],
  };
}

export default axiosPack;
