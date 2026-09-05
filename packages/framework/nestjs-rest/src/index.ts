// @suss/framework-nestjs-rest: the PatternPack for NestJS REST controllers
// (`@nestjs/common`).
//
// NestJS expresses REST endpoints as classes decorated with
// `@Controller(pathPrefix?)`, where each method has an HTTP-verb decorator on
// it (`@Get`, `@Post`, `@Put`, `@Delete`, `@Patch`, `@Options`, `@Head`, or
// `@All`). The framework wires routing internally, so there is no
// `app.get(...)` or `router.get(...)` registration call in user code, and the
// existing Express and Fastify
// `registrationCall` discovery finds nothing here. Decorator-driven
// route discovery covers it.
//
// Route path is the class decorator's first arg (path prefix) joined
// with the method decorator's first arg (path suffix). Both are
// optional. `@Controller()` mounts at root, and `@Get()` matches the
// controller's prefix exactly.
//
// HTTP method comes from the method decorator's name itself (`@Get`
// becomes "GET", `@Post` becomes "POST", and so on). `@All` maps to "*",
// which downstream pairing treats as a wildcard matching every method.
//
// Inputs map by parameter decorator. NestJS uses `@Body`, `@Param`,
// `@Query`, `@Headers`, `@Req` / `@Request`, `@Res` / `@Response`,
// and `@Next`. `@Param('id')` and `@Query('search')` accept an
// optional field name: v0 surfaces these uniformly as their role,
// not the field path.
//
// Deferred:
//   - `@Param('id') id: string` field-level shape: today every
//     `@Param` lands as a single "pathParams" Input regardless of the
//     declared field name. Adequate for the binding identity; pairing
//     logic that wants per-arg type checking will need richer
//     decorator-arg parsing.
//   - Path normalisation for NestJS-style globs (`*` / `(.*)`) is
//     deferred: the joined path goes through unchanged today.
//   - Class inheritance / mixins: controllers split across an
//     abstract base + concrete child are discovered separately but
//     pairing doesn't yet collapse them.

import { z } from "zod";

import type { PatternPack } from "@suss/extractor";

/**
 * What this pack's options may say. The CLI parses a
 * `-f nestjs-rest=config.json` file against it, minus the keys a dependency
 * stub fills, which a config file may not set.
 */
export const optionsSchema = z
  .object({
    /**
     * Class decorators this project composes `@Controller()` into, for
     * the cases the adapter cannot follow on its own.
     *
     * A wrapper written in the project needs no entry here: the adapter
     * resolves a class decorator to the function behind it and accepts it
     * when calling that function calls `Controller` from
     * `@nestjs/common`. What is left for this option is a wrapper whose
     * body is not in the project, so there is nothing to read.
     */
    classDecorators: z.array(z.string()).optional(),
  })
  .strict();

export type NestjsRestPackOptions = z.infer<typeof optionsSchema>;

export function nestjsRestFramework(
  options: NestjsRestPackOptions = {},
): PatternPack {
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
          // First match wins, so the framework's own decorator is
          // tried before any wrapper a project names.
          classDecorators: ["Controller", ...(options.classDecorators ?? [])],
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
        requiresImport: ["@nestjs/common"],
      },
    ],

    terminals: [
      // NestJS controllers serialise the returned value as the
      // response body and pick a 200 default unless the method
      // declares `@HttpCode(N)` (deferred: that decorator is
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
        // A method that runs off the end returns undefined, and Nest
        // sends the same 200 with an empty body it sends for a bare
        // `return;`. Only `@HttpCode(N)` changes that.
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
