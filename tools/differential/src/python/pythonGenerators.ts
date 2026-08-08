// pythonGenerators.ts: fast-check arbitraries over the Python program
// DSL.
//
// The whole space is the sound tier. Every shape here is either one the
// shipped packs claim a path for, or one they document as an
// abstention, and the adjudicator penalizes neither abstaining nor
// declining. So a falseClaim from any of it is an undocumented
// extraction bug.

import fc from "fast-check";

import type {
  FastapiGroupSpec,
  FastapiProgramSpec,
  FastapiRouteSpec,
  FlaskApiMount,
  FlaskImportStyle,
  FlaskMethodSpec,
  FlaskMountSite,
  FlaskNamespaceMountPath,
  FlaskNamespacePath,
  FlaskNamespaceSpec,
  FlaskNoValue,
  FlaskProgramSpec,
  FlaskResourceSpec,
  FlaskWrittenPrefix,
  PyStatusSpec,
  PythonProgramSpec,
  PyVerb,
} from "./pythonProgram.js";

const SEGMENTS = [
  "todos",
  "orders",
  "items",
  "users",
  "reports",
  "notes",
  "tags",
  "events",
];

const VERBS: PyVerb[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];

const BODY_VERBS = new Set<PyVerb>(["POST", "PUT", "PATCH"]);

// 204 and 304 are left out on purpose: both forbid a response body,
// and every handler we generate returns one.
const STATUSES = [201, 202, 400, 404, 418];

const arbStatus: fc.Arbitrary<PyStatusSpec> = fc.oneof(
  { weight: 2, arbitrary: fc.constant<PyStatusSpec>({ type: "absent" }) },
  {
    weight: 2,
    arbitrary: fc
      .constantFrom(...STATUSES)
      .map((code): PyStatusSpec => ({ type: "literal", code })),
  },
  {
    weight: 1,
    arbitrary: fc
      .constantFrom(...STATUSES)
      .map((code): PyStatusSpec => ({ type: "computed", code })),
  },
);

const arbFastapiRoute: fc.Arbitrary<FastapiRouteSpec> = fc
  .record({
    verb: fc.constantFrom(...VERBS),
    segment: fc.constantFrom(...SEGMENTS),
    hasPathParam: fc.boolean(),
    pathParamTyped: fc.boolean(),
    pathComputed: fc.oneof(
      { weight: 4, arbitrary: fc.constant(false) },
      { weight: 1, arbitrary: fc.constant(true) },
    ),
    status: arbStatus,
    response: fc.constantFrom<FastapiRouteSpec["response"]>(
      "none",
      "returnAnnotation",
      "responseModel",
    ),
    hasBodyParam: fc.boolean(),
    hasQueryParam: fc.boolean(),
  })
  .map((route) => ({
    ...route,
    // A computed path stays parameterless, so its serve-time value is one
    // string concatenation.
    hasBodyParam: route.hasBodyParam && BODY_VERBS.has(route.verb),
    hasPathParam: route.hasPathParam && !route.pathComputed,
  }));

const arbRoutes = fc.array(arbFastapiRoute, { minLength: 1, maxLength: 2 });

const arbFastapiGroup: fc.Arbitrary<FastapiGroupSpec> = fc.oneof(
  {
    weight: 3,
    arbitrary: arbRoutes.map(
      (routes): FastapiGroupSpec => ({ type: "app", routes }),
    ),
  },
  {
    weight: 3,
    arbitrary: fc
      .record({
        ownPrefix: fc.constantFrom<"literal" | "absent">("literal", "absent"),
        mountPrefix: fc.constantFrom<"literal" | "absent">("literal", "absent"),
        crossFile: fc.boolean(),
        routes: arbRoutes,
      })
      .map((group): FastapiGroupSpec => ({ type: "mounted", ...group })),
  },
  {
    weight: 1,
    arbitrary: arbRoutes.map(
      (routes): FastapiGroupSpec => ({ type: "computedOwnPrefix", routes }),
    ),
  },
  {
    weight: 1,
    arbitrary: arbRoutes.map(
      (routes): FastapiGroupSpec => ({ type: "computedMountPrefix", routes }),
    ),
  },
  {
    weight: 1,
    arbitrary: arbRoutes.map(
      (routes): FastapiGroupSpec => ({ type: "unmounted", routes }),
    ),
  },
  {
    weight: 1,
    arbitrary: arbRoutes.map(
      (routes): FastapiGroupSpec => ({ type: "rivalFactory", routes }),
    ),
  },
  {
    weight: 1,
    arbitrary: fc
      .record({ firstRoutes: arbRoutes, secondRoutes: arbRoutes })
      .map((group): FastapiGroupSpec => ({ type: "reassigned", ...group })),
  },
  {
    weight: 1,
    arbitrary: arbRoutes.map(
      (routes): FastapiGroupSpec => ({ type: "mountedTwice", routes }),
    ),
  },
  {
    weight: 1,
    arbitrary: fc
      .record({ innerRoutes: arbRoutes, outerRoutes: arbRoutes })
      .map((group): FastapiGroupSpec => ({ type: "nested", ...group })),
  },
);

export const arbFastapiProgramSpec: fc.Arbitrary<FastapiProgramSpec> = fc
  .array(arbFastapiGroup, { minLength: 1, maxLength: 3 })
  .map((groups) => ({ groups }));

const arbFlaskMethod: fc.Arbitrary<FlaskMethodSpec> = fc
  .record({
    verb: fc.constantFrom(...VERBS),
    annotated: fc.boolean(),
    returnStyle: fc.constantFrom<FlaskMethodSpec["returnStyle"]>(
      "dict",
      "tuple",
    ),
    tupleStatus: fc.constantFrom(...STATUSES),
  })
  .map((method) => ({
    ...method,
    // An annotated method returns the plain 200 dict its annotation declares.
    returnStyle: method.annotated ? ("dict" as const) : method.returnStyle,
  }));

const arbFlaskResource: fc.Arbitrary<FlaskResourceSpec> = fc
  .record({
    segment: fc.constantFrom(...SEGMENTS),
    hasPathParam: fc.boolean(),
    converterArgs: fc.boolean(),
    pathComputed: fc.oneof(
      { weight: 4, arbitrary: fc.constant(false) },
      { weight: 1, arbitrary: fc.constant(true) },
    ),
    methods: fc
      .uniqueArray(arbFlaskMethod, {
        minLength: 1,
        maxLength: 3,
        selector: (method) => method.verb,
      })
      .filter((methods) => methods.length >= 1),
  })
  .map((resource) => resource);

const arbFlaskResources = fc.array(arbFlaskResource, {
  minLength: 1,
  maxLength: 2,
});

/** The library reads all four spellings as no value, so draw them evenly. */
const arbNoValue: fc.Arbitrary<FlaskNoValue> = fc.constantFrom<FlaskNoValue>(
  "empty",
  "none",
  "false",
  "zero",
);

// The library strips trailing slashes from a namespace path before it
// stores it, so both literal spellings serve the same paths.
const arbFlaskNamespacePath: fc.Arbitrary<FlaskNamespacePath> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.boolean().map(
      (trailingSlash): FlaskNamespacePath => ({
        type: "literal",
        trailingSlash,
      }),
    ),
  },
  { weight: 1, arbitrary: fc.constant<FlaskNamespacePath>({ type: "root" }) },
  { weight: 1, arbitrary: fc.constant<FlaskNamespacePath>({ type: "absent" }) },
  {
    weight: 2,
    arbitrary: arbNoValue.map(
      (written): FlaskNamespacePath => ({ type: "noValue", written }),
    ),
  },
  {
    weight: 1,
    arbitrary: fc.constant<FlaskNamespacePath>({ type: "computed" }),
  },
);

// A falsy mount path is no override at all, which the pack reads rather
// than abstains over.
const arbFlaskMountPath: fc.Arbitrary<FlaskNamespaceMountPath> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.constant<FlaskNamespaceMountPath>({ type: "absent" }),
  },
  {
    weight: 2,
    arbitrary: fc.constant<FlaskNamespaceMountPath>({ type: "override" }),
  },
  {
    weight: 2,
    arbitrary: arbNoValue.map(
      (written): FlaskNamespaceMountPath => ({ type: "noValue", written }),
    ),
  },
  {
    weight: 1,
    arbitrary: fc.constant<FlaskNamespaceMountPath>({ type: "computed" }),
  },
);

const arbFlaskMountSite: fc.Arbitrary<FlaskMountSite> =
  fc.constantFrom<FlaskMountSite>(
    "module",
    "factory",
    "loopLiteral",
    "loopCall",
  );

const arbFlaskNamespace: fc.Arbitrary<FlaskNamespaceSpec> = fc.oneof(
  {
    weight: 5,
    arbitrary: fc
      .record({
        path: arbFlaskNamespacePath,
        mountPath: arbFlaskMountPath,
        mountSite: arbFlaskMountSite,
        emptyPathResource: fc.boolean(),
        resources: arbFlaskResources,
      })
      .map(
        (namespace): FlaskNamespaceSpec => ({
          type: "mounted",
          ...namespace,
        }),
      ),
  },
  {
    weight: 1,
    arbitrary: arbFlaskResources.map(
      (resources): FlaskNamespaceSpec => ({ type: "unmounted", resources }),
    ),
  },
  {
    weight: 1,
    arbitrary: arbFlaskResources.map(
      (resources): FlaskNamespaceSpec => ({ type: "mountedTwice", resources }),
    ),
  },
  {
    weight: 1,
    arbitrary: fc
      .record({
        firstResources: arbFlaskResources,
        secondResources: arbFlaskResources,
      })
      .map(
        (namespace): FlaskNamespaceSpec => ({
          type: "reassigned",
          ...namespace,
        }),
      ),
  },
);

/**
 * How a prefix is written where the library concatenates it as given.
 * The trailing-slash literal is drawn as often as the plain one: the
 * app really does serve a doubled slash there, which is the cell a
 * reader that strips one gets wrong.
 */
function arbFlaskWrittenPrefix(
  noValue: fc.Arbitrary<FlaskNoValue>,
): fc.Arbitrary<FlaskWrittenPrefix> {
  return fc.oneof(
    {
      weight: 4,
      arbitrary: fc.boolean().map(
        (trailingSlash): FlaskWrittenPrefix => ({
          type: "literal",
          trailingSlash,
        }),
      ),
    },
    {
      weight: 2,
      arbitrary: fc.constant<FlaskWrittenPrefix>({ type: "absent" }),
    },
    {
      weight: 2,
      arbitrary: noValue.map(
        (written): FlaskWrittenPrefix => ({ type: "noValue", written }),
      ),
    },
    {
      weight: 1,
      arbitrary: fc.constant<FlaskWrittenPrefix>({ type: "computed" }),
    },
  );
}

/**
 * Flask hands a blueprint's `url_prefix` straight to `rstrip`, so
 * `False` and `0` stop the app from starting where `""` and `None`
 * serve the same paths as writing none. Only what runs is generated.
 */
const arbBlueprintPrefix = arbFlaskWrittenPrefix(
  fc.constantFrom<FlaskNoValue>("empty", "none"),
);

const arbApiPrefix = arbFlaskWrittenPrefix(arbNoValue);

/**
 * What the `Api` is built on: the app itself, or a blueprint carrying
 * a prefix of its own, reaching the `Api` at its construction or
 * through a later handoff. The last two are the registrations the pack
 * documents as abstentions.
 */
const arbFlaskApiMount: fc.Arbitrary<FlaskApiMount> = fc.oneof(
  { weight: 3, arbitrary: fc.constant<FlaskApiMount>({ type: "app" }) },
  {
    weight: 4,
    arbitrary: arbBlueprintPrefix.map(
      (prefix): FlaskApiMount => ({ type: "blueprint", prefix }),
    ),
  },
  {
    weight: 2,
    arbitrary: arbBlueprintPrefix.map(
      (prefix): FlaskApiMount => ({ type: "blueprintHandedOver", prefix }),
    ),
  },
  {
    weight: 1,
    arbitrary: fc.constant<FlaskApiMount>({
      type: "blueprintRegisteredElsewhere",
    }),
  },
  {
    weight: 1,
    arbitrary: fc.constant<FlaskApiMount>({ type: "blueprintNested" }),
  },
);

export const arbFlaskProgramSpec: fc.Arbitrary<FlaskProgramSpec> = fc
  .record({
    importStyle: fc.constantFrom<FlaskImportStyle>(
      "direct",
      "wrapper",
      "wrapperAliased",
    ),
    apiMount: arbFlaskApiMount,
    apiPrefix: arbApiPrefix,
    resources: fc.array(arbFlaskResource, { minLength: 1, maxLength: 3 }),
    namespaces: fc.array(arbFlaskNamespace, { minLength: 0, maxLength: 2 }),
  })
  // A resource reached through the project wrapper has a bare
  // function as its decorator, so extraction has no object to ask what
  // prefix comes before it and claims the decorator's path as
  // written. The wrapper's own namespace is pinned at "/" for that
  // reason, and the app the wrapper style builds is pinned to no
  // prefix for the same one.
  .map((spec) =>
    spec.importStyle === "direct"
      ? spec
      : {
          ...spec,
          apiMount: { type: "app" as const },
          apiPrefix: { type: "absent" as const },
        },
  );

export const arbPythonProgramSpec: fc.Arbitrary<PythonProgramSpec> = fc.oneof(
  arbFastapiProgramSpec.map(
    (program): PythonProgramSpec => ({ framework: "fastapi", program }),
  ),
  arbFlaskProgramSpec.map(
    (program): PythonProgramSpec => ({ framework: "flask-restx", program }),
  ),
);
