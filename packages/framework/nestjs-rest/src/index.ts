// @suss/framework-nestjs-rest — PatternPack for NestJS REST controllers
// (`@nestjs/common`).
//
// NestJS expresses REST endpoints as classes decorated with
// `@Controller(pathPrefix?)`, where each method carries an HTTP-verb
// decorator (`@Get` / `@Post` / `@Put` / `@Delete` / `@Patch` /
// `@Options` / `@Head` / `@All`). The framework wires routing
// internally, so there is no `app.get(...)` / `router.get(...)`
// registration call in user code — the existing Express / Fastify
// `registrationCall` discovery finds nothing here. Decorator-driven
// route discovery covers it.
//
// Route path is the class decorator's first arg (path prefix) joined
// with the method decorator's first arg (path suffix). Both are
// optional — `@Controller()` mounts at root, `@Get()` matches the
// controller's prefix exactly.
//
// HTTP method comes from the method decorator's name itself (`@Get`
// → "GET", `@Post` → "POST", etc.). `@All` maps to "*" — matches
// every method, treated as a wildcard by downstream pairing.
//
// Inputs map by parameter decorator. NestJS uses `@Body`, `@Param`,
// `@Query`, `@Headers`, `@Req` / `@Request`, `@Res` / `@Response`,
// and `@Next`. `@Param('id')` and `@Query('search')` accept an
// optional field name — v0 surfaces these uniformly as their role,
// not the field path.
//
// Deferred:
//   - `@Param('id') id: string` field-level shape: today every
//     `@Param` lands as a single "pathParams" Input regardless of the
//     declared field name. Adequate for the binding identity; pairing
//     logic that wants per-arg type checking will need richer
//     decorator-arg parsing.
//   - Path normalisation for NestJS-style globs (`*` / `(.*)`) is
//     deferred — the joined path goes through unchanged today.
//   - Class inheritance / mixins: controllers split across an
//     abstract base + concrete child are discovered separately but
//     pairing doesn't yet collapse them.

import type { PatternPack } from "@suss/extractor";

export function nestjsRestFramework(): PatternPack {
  return {
    name: "nestjs-rest",
    languages: ["typescript"],
    protocol: "http",

    discovery: [
      {
        kind: "handler",
        match: {
          type: "decoratedRoute",
          importModule: "@nestjs/common",
          // Bare `@Controller(...)` is the canonical NestJS shape;
          // project-internal wrappers compose it for cross-cutting
          // concerns (auth, logging, etc.). Listed here so common
          // codebase conventions discover without per-project pack
          // config.
          classDecorators: [
            "Controller",
            "PublicController",
            "AuthedController",
            "ApiController",
          ],
          methodDecoratorRouteMap: {
            Get: "GET",
            Post: "POST",
            Put: "PUT",
            Delete: "DELETE",
            Patch: "PATCH",
            Options: "OPTIONS",
            Head: "HEAD",
            All: "*",
          },
        },
      },
    ],

    terminals: [
      // NestJS controllers serialise the returned value as the
      // response body and pick a 200 default unless the method
      // declares `@HttpCode(N)` (deferred — that decorator is
      // metadata-only). Match bare returns and treat object literals
      // / identifiers / awaited calls as 200 responses.
      {
        kind: "response",
        match: { type: "returnStatement", excludeCallReturns: false },
        extraction: {
          defaultStatusCode: 200,
        },
      },
      {
        // `throw new HttpException(msg, status)` / `throw new
        // BadRequestException()` etc. NestJS maps these to HTTP
        // responses; v0 records the exception type so downstream
        // contract-checking can pair it with the wire status that
        // the framework would emit.
        kind: "throw",
        match: { type: "throwExpression" },
        extraction: {},
      },
      {
        // Many controllers fall through (return undefined) when the
        // operation is fire-and-forget (`@HttpCode(204)` for
        // delete-style). Keep a default transition so
        // `transitions: []` isn't the surface shape.
        kind: "response",
        match: { type: "functionFallthrough" },
        extraction: {
          defaultStatusCode: 200,
        },
      },
    ],

    inputMapping: {
      type: "decoratedParams",
      decoratorRoleMap: {
        Body: "requestBody",
        Param: "pathParams",
        Query: "queryParams",
        Headers: "headers",
        Req: "request",
        Request: "request",
        Res: "response",
        Response: "response",
        Next: "next",
        Session: "session",
        Ip: "ip",
        HostParam: "host",
        UploadedFile: "file",
        UploadedFiles: "files",
      },
    },
  };
}

export default nestjsRestFramework;
