// pythonGenerators.ts: fast-check arbitraries over the Python program
// DSL.
//
// The whole space is the sound tier: every shape here is either one
// the shipped packs claim a path for or one they document as an
// abstention, and the adjudicator penalizes neither abstaining nor
// declining. A falseClaim from any of it is an undocumented
// extraction bug.

import fc from "fast-check";

import type {
  FastapiGroupSpec,
  FastapiProgramSpec,
  FastapiRouteSpec,
  FlaskImportStyle,
  FlaskMethodSpec,
  FlaskProgramSpec,
  FlaskResourceSpec,
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
// and every generated handler answers with one.
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
    // A body parameter belongs to verbs that carry request bodies; a
    // computed path stays parameterless to keep its serve-time value
    // a single string concatenation.
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
    // An annotated method answers the plain 200 dict its annotation
    // declares (see the DSL's doc comment).
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

export const arbFlaskProgramSpec: fc.Arbitrary<FlaskProgramSpec> = fc.record({
  importStyle: fc.constantFrom<FlaskImportStyle>(
    "direct",
    "wrapper",
    "wrapperAliased",
  ),
  resources: fc.array(arbFlaskResource, { minLength: 1, maxLength: 3 }),
});

/** Both frameworks, drawn evenly, so one sampled stream covers the two packs. */
export const arbPythonProgramSpec: fc.Arbitrary<PythonProgramSpec> = fc.oneof(
  arbFastapiProgramSpec.map(
    (program): PythonProgramSpec => ({ framework: "fastapi", program }),
  ),
  arbFlaskProgramSpec.map(
    (program): PythonProgramSpec => ({ framework: "flask-restx", program }),
  ),
);
