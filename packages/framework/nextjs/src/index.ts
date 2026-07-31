// @suss/framework-nextjs — PatternPack for Next.js route handlers.
//
// Next.js puts the route in the tree rather than in a registration call.
// A file at `app/api/orders/[id]/route.ts` serves `/api/orders/{id}`,
// and each HTTP method it answers is a separate export:
//
//   export async function GET(req: Request, { params }) {
//     const order = await findOrder(params.id);
//     if (!order) return NextResponse.json({ error: "gone" }, { status: 404 });
//     return NextResponse.json(order);
//   }
//
// So discovery looks at where a file sits and which names it exports,
// and the route comes out of the path. An `/api/orders/{id}` handler
// here pairs with a client calling the same URL, and with an Express
// service writing `/api/orders/:id`.
//
// The older `pages/api` routes are covered too, with one difference
// worth knowing: a pages handler is a single default export that
// switches on `req.method` inside, so it answers every method and this
// pack reports no method for it. It pairs by path but not by method.
//
// Out of scope for now: server actions, whose identity is a compiler
// generated ID rather than a URL, and page components, which the React
// pack already reads.

import type { BindingExtraction, PatternPack } from "@suss/extractor";

/** The methods a route file can export, one function per method. */
const ROUTE_METHODS = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
];

/**
 * How the app directory names a route. Nested directories are path
 * segments, a directory in brackets is a parameter, a directory in
 * parentheses groups files without showing up in the URL, and the
 * filename says what the file is rather than adding a segment.
 */
const APP_ROUTES: Extract<BindingExtraction["path"], { type: "fromFilename" }> =
  {
    type: "fromFilename",
    root: "app",
    dropBasenames: ["route", "page"],
    dynamic: "brackets",
    dropParenthesized: true,
  };

/** The same idea in the pages directory, where the file is the route. */
const PAGES_ROUTES: Extract<
  BindingExtraction["path"],
  { type: "fromFilename" }
> = {
  type: "fromFilename",
  root: "pages",
  dropBasenames: ["index"],
  dynamic: "brackets",
};

/**
 * Modules the response helpers come from. `NextResponse` is Next's own;
 * `Response` is the platform's and is imported from nowhere, so calls
 * on it are matched without a gate.
 */
const NEXT_SERVER = ["next/server"];

export function nextjsFramework(): PatternPack {
  return {
    name: "nextjs",
    protocol: "http",
    languages: ["typescript", "javascript"],

    discovery: [
      {
        kind: "handler",
        match: {
          type: "fileConvention",
          filePattern: "**/app/**/route.{ts,tsx,js,jsx,mts,mjs}",
          exportNames: ROUTE_METHODS,
        },
        bindingExtraction: {
          method: { type: "fromExportName" },
          path: APP_ROUTES,
        },
      },
      {
        kind: "handler",
        match: {
          type: "fileConvention",
          filePattern: "**/pages/api/**/*.{ts,tsx,js,jsx,mts,mjs}",
          exportNames: ["default"],
        },
        bindingExtraction: {
          // One export answers every method, so the pack states none
          // rather than picking one and being wrong six times out of
          // seven.
          method: { type: "literal", value: "" },
          path: PAGES_ROUTES,
        },
      },
    ],

    terminals: [
      {
        // NextResponse.json(body, { status })
        kind: "response",
        match: {
          type: "functionCall",
          functionName: "NextResponse.json",
          requiresImport: NEXT_SERVER,
        },
        extraction: {
          body: { from: "argument", position: 0 },
          statusCode: { from: "argumentProperty", position: 1, name: "status" },
          defaultStatusCode: 200,
        },
      },
      {
        // Response.json(body, { status }), the platform's own, which a
        // handler can return without importing anything.
        kind: "response",
        match: { type: "functionCall", functionName: "Response.json" },
        extraction: {
          body: { from: "argument", position: 0 },
          statusCode: { from: "argumentProperty", position: 1, name: "status" },
          defaultStatusCode: 200,
        },
      },
      {
        // NextResponse.redirect(url) sends a 307 unless the caller says
        // otherwise, and the alternative is written as an init object
        // this pack does not read yet.
        kind: "response",
        match: {
          type: "functionCall",
          functionName: "NextResponse.redirect",
          requiresImport: NEXT_SERVER,
        },
        extraction: { defaultStatusCode: 307 },
      },
      {
        // A pages handler writes to the response it was handed, the
        // same shape Express uses.
        kind: "response",
        match: {
          type: "parameterMethodCall",
          parameterPosition: 1,
          methodChain: ["status", "json"],
        },
        extraction: {
          statusCode: { from: "argument", position: 0 },
          body: { from: "argument", position: 0 },
        },
      },
      {
        kind: "response",
        match: {
          type: "parameterMethodCall",
          parameterPosition: 1,
          methodChain: ["json"],
        },
        extraction: {
          body: { from: "argument", position: 0 },
          defaultStatusCode: 200,
        },
      },
      {
        kind: "throw",
        match: { type: "throwExpression" },
        extraction: {},
      },
    ],

    // A route handler takes the request first. The app directory hands
    // it a context object holding the route parameters; a pages handler
    // takes the response object there instead.
    inputMapping: {
      type: "positionalParams",
      params: [
        { position: 0, role: "request" },
        { position: 1, role: "context" },
      ],
    },
  };
}

export default nextjsFramework;
