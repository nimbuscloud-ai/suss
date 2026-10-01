// NestJS wires routing itself, so user code has no `app.get(...)` call to
// find and this pack discovers routes by their decorators. The README
// covers how a path and method are built and what is not read yet.

import { z } from "zod";

import type { PatternPack } from "@suss/extractor";
import type { PackDeclaration } from "@suss/ir-core";

/**
 * The CLI checks a `-f nestjs-rest=config.json` file against this schema.
 * A config file may not set a key that only a dependency stub fills.
 */
export const optionsSchema = z
  .object({
    /**
     * Class decorators that wrap `@Controller()` in a package outside the
     * project. A dependency stub fills this. A wrapper written in the
     * project needs no entry, because the adapter reads its body and
     * sees it call `Controller` from `@nestjs/common`.
     */
    classDecorators: z.array(z.string()).optional(),
  })
  .strict();

export type NestjsRestPackOptions = z.infer<typeof optionsSchema>;

// The numbers `RequestMethod` in `@nestjs/common` gives each verb.
const REQUEST_METHODS: Record<number, string> = {
  0: "GET",
  1: "POST",
  2: "PUT",
  3: "DELETE",
  4: "PATCH",
  5: "*",
  6: "OPTIONS",
  7: "HEAD",
};

// The status each exception class `@nestjs/common` exports sends.
const NEST_EXCEPTION_STATUSES: Record<string, number> = {
  BadRequestException: 400,
  UnauthorizedException: 401,
  ForbiddenException: 403,
  NotFoundException: 404,
  MethodNotAllowedException: 405,
  NotAcceptableException: 406,
  RequestTimeoutException: 408,
  ConflictException: 409,
  GoneException: 410,
  PreconditionFailedException: 412,
  PayloadTooLargeException: 413,
  UnsupportedMediaTypeException: 415,
  ImATeapotException: 418,
  MisdirectedException: 421,
  UnprocessableEntityException: 422,
  InternalServerErrorException: 500,
  NotImplementedException: 501,
  BadGatewayException: 502,
  ServiceUnavailableException: 503,
  GatewayTimeoutException: 504,
  HttpVersionNotSupportedException: 505,
};

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
          // The first match wins, so the framework's own decorator is
          // tried before any wrapper.
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
          // Nest sends 201 for a POST and 200 for every other verb, and
          // `@HttpCode(n)` sets the status for one handler.
          defaultStatusCodes: { Post: 201 },
          statusCodeDecorator: "HttpCode",
          globalPrefix: {
            method: "setGlobalPrefix",
            application: {
              importModule: "@nestjs/core",
              importName: "NestFactory",
              factory: "create",
            },
            // An exclusion is a path, or a `RouteInfo` whose method is a
            // member of Nest's `RequestMethod` enum.
            exclude: {
              option: "exclude",
              pathKey: "path",
              methodKey: "method",
              methods: REQUEST_METHODS,
            },
          },
        },
        requiresImport: ["@nestjs/common"],
      },
    ],

    terminals: [
      // NestJS sends the returned value as the body. The route's own
      // status, from its verb or `@HttpCode`, replaces this 200.
      {
        kind: "response",
        match: { type: "returnStatement", excludeCallReturns: false },
        extraction: {
          defaultStatusCode: 200,
        },
      },
      {
        // `throw new BadRequestException()`: NestJS's exception filter
        // sends the status that class is for. Any other throw keeps no
        // status and stays a throw.
        kind: "throw",
        match: { type: "throwExpression" },
        extraction: {
          statusCode: { from: "constructor", codes: NEST_EXCEPTION_STATUSES },
        },
        producesResponse: true,
      },
      {
        // A method that runs off the end returns undefined, and Nest
        // sends the same empty response it sends for a bare `return;`.
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

export const declares: PackDeclaration = {
  kind: "framework",
  package: "@suss/framework-nestjs-rest",
  dependencies: [{ ecosystem: "npm", name: "@nestjs/common" }],
  reads: "NestJS REST controllers.",
};

export default nestjsRestFramework;
