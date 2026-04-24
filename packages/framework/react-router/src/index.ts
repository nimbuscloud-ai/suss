// @suss/framework-react-router — PatternPack for React Router

import type { PatternPack } from "@suss/extractor";

/**
 * Status codes for the `http-errors` package's named constructors.
 * React Router loaders / actions throw `httpErrorJson(new HttpError.X())`
 * and the arg's class name is the status source. Kept as a module-scope
 * constant so pack consumers can inspect / extend the mapping.
 */
const HTTP_ERRORS_CODES: Record<string, number> = {
  BadRequest: 400,
  Unauthorized: 401,
  PaymentRequired: 402,
  Forbidden: 403,
  NotFound: 404,
  MethodNotAllowed: 405,
  NotAcceptable: 406,
  RequestTimeout: 408,
  Conflict: 409,
  Gone: 410,
  PayloadTooLarge: 413,
  UnsupportedMediaType: 415,
  ImATeapot: 418,
  UnprocessableEntity: 422,
  TooManyRequests: 429,
  InternalServerError: 500,
  NotImplemented: 501,
  BadGateway: 502,
  ServiceUnavailable: 503,
  GatewayTimeout: 504,
};

export function reactRouterFramework(): PatternPack {
  return {
    name: "react-router",
    protocol: "http",
    languages: ["typescript", "javascript"],

    discovery: [
      {
        kind: "loader",
        match: { type: "namedExport", names: ["loader"] },
        bindingExtraction: {
          method: { type: "literal", value: "GET" },
          path: { type: "fromFilename" },
        },
      },
      {
        kind: "action",
        match: { type: "namedExport", names: ["action"] },
        bindingExtraction: {
          method: { type: "literal", value: "POST" },
          path: { type: "fromFilename" },
        },
      },
      {
        kind: "component",
        match: { type: "namedExport", names: ["default"] },
      },
    ],

    terminals: [
      {
        // json(data, init?) — e.g. return json({ user })
        kind: "response",
        match: { type: "functionCall", functionName: "json" },
        extraction: {
          body: { from: "argument", position: 0 },
          defaultStatusCode: 200,
        },
      },
      {
        // data(value, init?) — React Router v7 replacement for json()
        kind: "response",
        match: { type: "functionCall", functionName: "data" },
        extraction: {
          body: { from: "argument", position: 0 },
          defaultStatusCode: 200,
        },
      },
      {
        // redirect(url, status?) — e.g. return redirect("/login")
        kind: "response",
        match: { type: "functionCall", functionName: "redirect" },
        extraction: {
          statusCode: { from: "argument", position: 1 },
          defaultStatusCode: 302,
        },
      },
      {
        // Loaders return data directly
        kind: "return",
        match: { type: "returnShape" },
        extraction: {
          body: { from: "argument", position: 0 },
        },
      },
      {
        // Loaders throw `httpErrorJson(new HttpError.NotFound("…"))` from
        // the `http-errors` package. The arg's class name carries the
        // status: resolve through `argumentConstructor` rather than taking
        // the arg's raw source text as a status value.
        kind: "throw",
        match: {
          type: "throwExpression",
          constructorPattern: "httpErrorJson",
        },
        extraction: {
          statusCode: {
            from: "argumentConstructor",
            position: 0,
            codes: HTTP_ERRORS_CODES,
          },
          body: { from: "argument", position: 1 },
        },
      },
    ],

    inputMapping: {
      type: "singleObjectParam",
      paramPosition: 0,
      knownProperties: {
        request: "request",
        params: "pathParams",
        context: "context",
      },
    },
  };
}

export default reactRouterFramework;
