import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CACHE_DIR_ENV,
  extractionCacheDirFor,
  liveRecordFor,
  mapFolderFor,
} from "./cacheLocation.js";

const before = process.env[CACHE_DIR_ENV];

afterEach(() => {
  if (before === undefined) {
    delete process.env[CACHE_DIR_ENV];
  } else {
    process.env[CACHE_DIR_ENV] = before;
  }
});

describe("where suss keeps its own files", () => {
  it("is under .suss in the project when nothing is chosen", () => {
    delete process.env[CACHE_DIR_ENV];

    expect(extractionCacheDirFor("/work/shop")).toBe(
      path.join("/work/shop", ".suss", "cache"),
    );
    expect(liveRecordFor("/work/shop")).toBe(
      path.join("/work/shop", ".suss", "live", "server.json"),
    );
    expect(mapFolderFor("/work/shop")).toBe(path.join("/work/shop", ".suss"));
  });

  it("puts each project's map in its own folder under the chosen directory", () => {
    process.env[CACHE_DIR_ENV] = "/tmp/state";

    const shop = mapFolderFor("/work/shop");

    expect(shop.startsWith(path.join("/tmp/state", "map"))).toBe(true);
    expect(shop).not.toBe(mapFolderFor("/work/blog"));
  });

  it("is under the chosen directory, apart for each project", () => {
    process.env[CACHE_DIR_ENV] = "/tmp/state";

    const shop = extractionCacheDirFor("/work/shop");
    const blog = extractionCacheDirFor("/work/blog");

    expect(shop.startsWith(path.join("/tmp/state", "cache"))).toBe(true);
    expect(blog.startsWith(path.join("/tmp/state", "cache"))).toBe(true);
    expect(shop).not.toBe(blog);
    expect(liveRecordFor("/work/shop").startsWith("/tmp/state")).toBe(true);
  });

  it("reads an empty variable as not chosen", () => {
    process.env[CACHE_DIR_ENV] = "";

    expect(extractionCacheDirFor("/work/shop")).toBe(
      path.join("/work/shop", ".suss", "cache"),
    );
  });
});
