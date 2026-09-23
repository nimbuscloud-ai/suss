/**
 * Next.js takes a route from where its file is, with no registration
 * call. `app/api/orders/[id]/route.ts` serves `/api/orders/{id}`, and each
 * HTTP method it serves is a separate export, so discovery reads the
 * file's path and its export names. Page components are left to the
 * React pack. The README covers `pages/api` handlers and server actions.
 */

import { nextjsServerActions } from "./serverActions.js";

import type { BindingExtraction, PatternPack } from "@suss/extractor";
import type { PackDeclaration } from "@suss/ir-core";

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
 * In the app directory each nested directory is a path segment and a
 * directory in brackets is a parameter. A directory in parentheses groups
 * files without adding to the URL, and the file name `route` or `page`
 * adds no segment.
 */
const APP_ROUTES: Extract<BindingExtraction["path"], { type: "fromFilename" }> =
  {
    type: "fromFilename",
    root: "app",
    dropBasenames: ["route", "page"],
    dynamic: "brackets",
    dropParenthesized: true,
  };

/** In the pages directory the file itself is the route. */
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
 * `Response` is a platform global that needs no import, so only the
 * `NextResponse` terminals check for this module.
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
          // One default export serves every method, so pairing matches it
          // against whichever method a caller uses.
          method: { type: "literal", value: "*" },
          path: PAGES_ROUTES,
        },
      },
    ],

    discoverUnits: nextjsServerActions,

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
        // handler can call without an import.
        kind: "response",
        match: { type: "functionCall", functionName: "Response.json" },
        extraction: {
          body: { from: "argument", position: 0 },
          statusCode: { from: "argumentProperty", position: 1, name: "status" },
          defaultStatusCode: 200,
        },
      },
      {
        // new Response(body, { status }), which a handler returns for a
        // body that is not JSON, such as a stream or plain text.
        kind: "response",
        match: { type: "functionCall", functionName: "Response" },
        extraction: {
          body: { from: "argument", position: 0 },
          statusCode: { from: "argumentProperty", position: 1, name: "status" },
          defaultStatusCode: 200,
        },
      },
      {
        // NextResponse.redirect(url) sends a 307 by default. Another status
        // goes in an init object, which this pack does not read yet.
        kind: "response",
        match: {
          type: "functionCall",
          functionName: "NextResponse.redirect",
          requiresImport: NEXT_SERVER,
        },
        extraction: { defaultStatusCode: 307 },
      },
      {
        // A pages handler writes to the response object passed to it, as
        // an Express handler does.
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

    // Both kinds of handler take the request first. An app handler gets a
    // context object with the route parameters second, and a pages handler
    // gets the response object in that position.
    inputMapping: {
      type: "positionalParams",
      params: [
        { position: 0, role: "request" },
        { position: 1, role: "context" },
      ],
    },
  };
}

export const declares: PackDeclaration = {
  kind: "framework",
  package: "@suss/framework-nextjs",
  dependencies: [{ ecosystem: "npm", name: "next" }],
  reads: `Next.js route handlers, pages and server actions. The route comes from where the file is on disk, and a \`"use server"\` function becomes an action unit.`,
};

export default nextjsFramework;
