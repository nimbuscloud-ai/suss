// pack.ts: the Python adapter's own pattern-pack contract.
//
// Not the TypeScript adapter's `PatternPack` (packages/extractor's
// `framework.ts`): that type's discovery variants are dispatched by
// ts-morph-specific handlers, and Python's two route shapes (a class
// decorator plus method-name dispatch, and a function decorator whose
// own attribute name carries the verb) have no exact match in that
// union anyway. Per the language-adapters proposal's invariant, match
// shapes stay per-language until a second implementation shows what's
// actually shared; this is that per-language shape for Python. A pack
// is still plain data, the same discipline the TypeScript packs
// follow: naming what a library defines, nothing a project chose.

export interface PythonPack {
  name: string;
  /** Wire protocol for the produced boundary bindings, e.g. "http". */
  protocol: string;
  discovery: PythonDiscoveryPattern[];
}

export type PythonDiscoveryPattern =
  | DecoratedClassRoute
  | DecoratedFunctionRoute;

/**
 * A class carries a decorator resolving to a configured module, whose
 * call's first string-literal argument is the route path. Each
 * HTTP-verb-named method declared directly in the class body becomes
 * its own discovered unit, verb read from the method's own name
 * rather than from a decorator on it (flask-restx's `Resource`
 * dispatch convention).
 *
 * Closest TypeScript analogue: `decoratedRoute` in
 * `@suss/extractor`'s `framework.ts`, which also tolerates a
 * project-wrapped `importModule`. It differs in where the verb comes
 * from (a per-method decorator there, the method's own name here), so
 * it isn't reused as-is.
 */
export interface DecoratedClassRoute {
  type: "decoratedClassRoute";
  /**
   * Modules a project may have imported the decorator from, directly
   * or through a project-local wrapper re-exporting it. Mirrors
   * `DiscoveryMatch["decoratedRoute"].importModule` on the TypeScript
   * side: the library names its own module here; a project's wrapper
   * module is supplied through pack options by whoever configures the
   * pack, not hardcoded into it.
   */
  importModule: string[];
  /** The decorator's name as the library exports it (e.g. "route" for flask-restx's `Namespace.route`). */
  decoratorName: string;
  /** Method name written in the class body, mapped to the HTTP verb it dispatches. */
  verbMethodNames: Record<string, string>;
}

/**
 * A function carries a decorator resolving to a configured module,
 * where the decorator's own attribute name is the HTTP verb and its
 * call's first string-literal argument is the route path (FastAPI's
 * `@app.get(path)` convention, whether `app` is itself imported or
 * built one hop away by a call to something imported, e.g. `app =
 * FastAPI()`).
 *
 * No TypeScript analogue: TS route registration is call-based
 * (`app.get(path, handler)`), never decorator-based with the verb
 * carried in the decorator's own name.
 */
export interface DecoratedFunctionRoute {
  type: "decoratedFunctionRoute";
  importModule: string[];
  /** Decorator attribute name, mapped to the HTTP verb it names (e.g. { get: "GET", post: "POST" }). */
  verbAttributeNames: Record<string, string>;
  /**
   * Keyword argument on the decorator call naming a locally-defined
   * class as the declared response body shape (FastAPI's
   * `response_model`). Unset means the pack doesn't declare one, and
   * the return annotation is the only source for the response shape.
   */
  responseModelKeyword?: string;
  /** Keyword argument on the decorator call naming a literal response status code (FastAPI's `status_code`). */
  statusCodeKeyword?: string;
}
