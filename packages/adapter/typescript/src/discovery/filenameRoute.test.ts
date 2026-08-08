import { describe, expect, it } from "vitest";

import { routePathFromFile } from "./filenameRoute.js";

import type { BindingExtraction } from "@suss/extractor";

type Convention = Extract<BindingExtraction["path"], { type: "fromFilename" }>;

const nextApp: Convention = {
  type: "fromFilename",
  root: "app",
  dropBasenames: ["route", "page"],
  dynamic: "brackets",
  dropParenthesized: true,
};

const nextPages: Convention = {
  type: "fromFilename",
  root: "pages",
  dropBasenames: ["index"],
  dynamic: "brackets",
};

const remixFlat: Convention = {
  type: "fromFilename",
  root: "app/routes",
  dropBasenames: ["_index", "route"],
  dynamic: "dollarPrefix",
  flat: true,
};

describe("routePathFromFile: Next.js app directory", () => {
  it("reads the directories below the root as the path", () => {
    expect(routePathFromFile("/src/app/api/orders/route.ts", nextApp)).toBe(
      "/api/orders",
    );
  });

  it("turns a bracketed directory into a placeholder", () => {
    expect(
      routePathFromFile("/src/app/api/orders/[id]/route.ts", nextApp),
    ).toBe("/api/orders/{id}");
  });

  it("drops a directory that only groups files", () => {
    expect(routePathFromFile("/src/app/(shop)/orders/page.tsx", nextApp)).toBe(
      "/orders",
    );
  });

  it("reads the root itself as the site root", () => {
    expect(routePathFromFile("/src/app/page.tsx", nextApp)).toBe("/");
  });

  it("names a catch-all after its parameter", () => {
    expect(routePathFromFile("/src/app/docs/[...slug]/page.tsx", nextApp)).toBe(
      "/docs/{slug}",
    );
  });

  it("names an optional catch-all the same way", () => {
    expect(
      routePathFromFile("/src/app/docs/[[...slug]]/page.tsx", nextApp),
    ).toBe("/docs/{slug}");
  });

  it("keeps a route segment that happens to be named like the root", () => {
    // Taking the last match here would give "/", which then pairs
    // with whatever calls the site root.
    expect(routePathFromFile("/src/app/api/app/route.ts", nextApp)).toBe(
      "/api/app",
    );
  });

  it("keeps a directory named like the filename it looks for", () => {
    expect(routePathFromFile("/src/app/api/page/route.ts", nextApp)).toBe(
      "/api/page",
    );
  });

  it("drops a slot, which renders alongside a route without being one", () => {
    expect(routePathFromFile("/src/app/@modal/photo/route.ts", nextApp)).toBe(
      "/photo",
    );
  });

  it("drops a directory Next keeps out of routing", () => {
    expect(routePathFromFile("/src/app/_lib/thing/route.ts", nextApp)).toBe(
      "/thing",
    );
  });

  it("resolves the outermost root, which a monorepo app directory is", () => {
    expect(
      routePathFromFile("/repo/apps/web/app/api/ping/route.ts", nextApp),
    ).toBe("/api/ping");
  });

  it("returns null for a file outside the root", () => {
    expect(routePathFromFile("/src/lib/db.ts", nextApp)).toBeNull();
  });

  it("returns null when the root is the last thing in the path", () => {
    // A directory named `app` with the file itself missing means there
    // is no route here, only the place routes would go.
    expect(routePathFromFile("/src/app", nextApp)).toBeNull();
  });

  it("ignores an empty segment a doubled separator leaves behind", () => {
    expect(routePathFromFile("/src/app//orders//page.tsx", nextApp)).toBe(
      "/orders",
    );
  });
});

describe("routePathFromFile: Next.js pages directory", () => {
  it("reads the filename as the last segment", () => {
    expect(routePathFromFile("/src/pages/api/orders.ts", nextPages)).toBe(
      "/api/orders",
    );
  });

  it("drops an index filename", () => {
    expect(routePathFromFile("/src/pages/api/index.ts", nextPages)).toBe(
      "/api",
    );
  });

  it("turns a bracketed filename into a placeholder", () => {
    expect(routePathFromFile("/src/pages/api/orders/[id].ts", nextPages)).toBe(
      "/api/orders/{id}",
    );
  });
});

describe("routePathFromFile: flat routes", () => {
  it("splits one filename into its segments", () => {
    expect(
      routePathFromFile("/app/routes/orders.$id.edit.tsx", remixFlat),
    ).toBe("/orders/{id}/edit");
  });

  it("reads a folder holding a route file", () => {
    expect(
      routePathFromFile("/app/routes/orders.$id/route.tsx", remixFlat),
    ).toBe("/orders/{id}");
  });

  it("reads the index route as the root", () => {
    expect(routePathFromFile("/app/routes/_index.tsx", remixFlat)).toBe("/");
  });

  it("ignores an empty piece a doubled dot leaves behind", () => {
    expect(routePathFromFile("/app/routes/orders..$id.tsx", remixFlat)).toBe(
      "/orders/{id}",
    );
  });

  it("leaves a segment alone when the convention names no parameter style", () => {
    expect(
      routePathFromFile("/app/routes/orders.$id.tsx", {
        type: "fromFilename",
        root: "app/routes",
        flat: true,
      }),
    ).toBe("/orders/$id");
  });
});
