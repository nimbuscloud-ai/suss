/**
 * Next.js takes a route from where its file is, with no registration
 * call. `app/api/orders/[id]/route.ts` serves `/api/orders/{id}`, and each
 * HTTP method it serves is a separate export, so discovery reads the
 * file's path and its export names. Page components are left to the
 * React pack. The README covers `pages/api` handlers and server actions.
 */

import fs from "node:fs";
import path from "node:path";

import { describeDiscovery } from "@suss/recognize";

import type {
  BindingExtraction,
  DeclaredDiscoveryPattern,
  PatternPack,
  ServedBesideDeclaration,
  TerminalPattern,
} from "@suss/extractor";
import type { PackDeclaration } from "@suss/ir-core";

/**
 * What the extraction cache keys this pack's results on. Bump it on any
 * change to the units it finds or what it reads into them.
 */
const VERSION = "2";

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

/**
 * A server action returns a value where a route handler sends a response,
 * so it keeps its own terminals. An action that runs off its end returns
 * nothing to the client, which is a normal outcome for a form action.
 */
const ACTION_TERMINALS: TerminalPattern[] = [
  { kind: "return", match: { type: "returnStatement" }, extraction: {} },
  { kind: "throw", match: { type: "throwExpression" }, extraction: {} },
  { kind: "return", match: { type: "functionFallthrough" }, extraction: {} },
];

const SOURCE_EXTENSIONS = "{ts,tsx,js,jsx,mts,mjs,md,mdx}";

/** Where Next.js looks for its config, at the app's root. */
const CONFIG_FILES = [
  "next.config.js",
  "next.config.mjs",
  "next.config.cjs",
  "next.config.ts",
  "next.config.mts",
];

/**
 * Where Next.js looks for the function it runs in front of every route,
 * at the app's root or under `src`. Version 16 calls it `proxy`.
 */
const MIDDLEWARE_FILES = ["middleware", "proxy"].flatMap((name) =>
  ["", "src/"].flatMap((under) =>
    ["ts", "js", "mts", "mjs"].map(
      (extension) => `${under}${name}.${extension}`,
    ),
  ),
);

/** Files under `app` that Next.js serves at their own path with an extension after it, such as `/sitemap.xml`. */
const METADATA_FILES = [
  "sitemap",
  "robots",
  "manifest",
  "icon",
  "apple-icon",
  "opengraph-image",
  "twitter-image",
  "favicon",
];

/**
 * What else a Next.js app serves a request at: its pages and metadata
 * files, what is under `public`, the rewrites and redirects its config
 * returns, and the middleware its matcher runs for. The config keys
 * that move every route are not read, so an app that sets one is not
 * checked for calls to missing routes.
 */
const SERVED_BESIDE: ServedBesideDeclaration = {
  pages: [
    { filePattern: `**/app/**/page.${SOURCE_EXTENSIONS}`, path: APP_ROUTES },
    {
      filePattern: `**/app/**/{${METADATA_FILES.join(",")}}.*`,
      path: APP_ROUTES,
      suffixed: true,
    },
    { filePattern: `**/pages/**/*.${SOURCE_EXTENSIONS}`, path: PAGES_ROUTES },
  ],
  staticDirectories: ["public"],
  config: {
    files: CONFIG_FILES,
    rules: [
      { key: "rewrites", by: "rewrite" },
      { key: "redirects", by: "redirect" },
    ],
    unread: ["basePath", "i18n", "pageExtensions", "exportPathMap"],
  },
  middleware: {
    files: MIDDLEWARE_FILES,
    export: "config",
    property: "matcher",
  },
  patternSyntax: "pathToRegexp",
};

/** The config file beside each file the run reads, which decides what the app serves besides its routes. */
function configFilesFor(files: readonly string[]): string[] {
  const found = new Set<string>();
  const looked = new Set<string>();
  for (const file of files) {
    let directory = path.dirname(path.resolve(file));
    while (!looked.has(directory)) {
      looked.add(directory);
      for (const name of CONFIG_FILES) {
        const candidate = path.join(directory, name);
        if (fs.existsSync(candidate)) {
          found.add(candidate);
        }
      }
      directory = path.dirname(directory);
    }
  }
  return [...found].sort();
}

/** The functions a `"use server"` directive turns into server actions, each bound by its module and name. */
const SERVER_ACTIONS: DeclaredDiscoveryPattern = {
  kind: "action",
  match: {
    type: "marked",
    word: "use server",
    scopes: ["module", "function"],
    name: ["assignedName", "countInFile"],
    countedAs: "serverAction",
    unit: {
      terminals: ACTION_TERMINALS,
      inputMapping: { type: "allPositional" },
    },
  },
};

export function nextjsFramework(): PatternPack {
  return {
    name: "nextjs",
    version: VERSION,
    protocol: "http",
    languages: ["typescript", "javascript"],
    servedBeside: SERVED_BESIDE,
    discoveryInputs: configFilesFor,

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
      SERVER_ACTIONS,
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

    declarations: { declarations: [describeDiscovery(SERVER_ACTIONS)] },
  };
}

export const declares: PackDeclaration = {
  kind: "framework",
  package: "@suss/framework-nextjs",
  dependencies: [{ ecosystem: "npm", name: "next" }],
  reads: `Next.js route handlers, pages and server actions. The route comes from where the file is on disk, and a \`"use server"\` function becomes an action unit.`,
};

export default nextjsFramework;
