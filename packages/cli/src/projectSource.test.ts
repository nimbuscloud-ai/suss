import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { firstSourceMatching, isProjectSourcePath } from "./projectSource.js";

const FETCH = /\bfetch\s*\(/;

describe("isProjectSourcePath", () => {
  it("counts a file the application is made of", () => {
    expect(isProjectSourcePath("src/api/orders.ts")).toBe(true);
    expect(isProjectSourcePath("lib/orders_client.rb")).toBe(true);
  });

  it("leaves out build scripts, tooling, config and tests", () => {
    for (const relative of [
      "scripts/fetch-local-schema.cjs",
      "tools/release.ts",
      "config/initializers/orders.rb",
      "src/__tests__/orders.ts",
      "src/orders.test.ts",
      "spec/orders_spec.rb",
      "tests/test_orders.py",
      "vite.config.ts",
      "src/orders.d.ts",
      "public/vendor.min.js",
      "app/javascript/application-bundle.js",
      "dist/index.js",
      "coverage/lcov-report/prettify.js",
    ]) {
      expect(isProjectSourcePath(relative), relative).toBe(false);
    }
  });
});

describe("firstSourceMatching", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-project-source-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function write(relative: string, contents: string): void {
    const file = path.join(dir, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  }

  it("reads a Rails app's client code, which has no tsconfig", () => {
    write("Gemfile", "source 'https://rubygems.org'\ngem 'rails'\n");
    write("scripts/release.js", "await fetch('/releases');\n");
    write("public/assets/application.js", "fetch('/compiled');\n");
    write("app/assets/builds/application.js", "fetch('/bundled');\n");
    write("node_modules/lib/index.js", "fetch('/dependency');\n");
    write("vendor/javascript/chart.js", "fetch('/vendored');\n");
    write("app/javascript/legacy.min.js", "fetch('/minified');\n");
    expect(firstSourceMatching(dir, "typescript", FETCH)).toBeNull();

    write(
      "app/javascript/orders.js",
      "export const load = () => fetch('/orders.json');\n",
    );
    expect(firstSourceMatching(dir, "typescript", FETCH)).toBe(
      path.join("app", "javascript", "orders.js"),
    );
  });

  it("reads what the tsconfig includes, wherever it is", () => {
    write("tsconfig.json", JSON.stringify({ include: ["app/**/*.ts"] }));
    write("src/unused.ts", "fetch('/unused');\n");
    expect(firstSourceMatching(dir, "typescript", FETCH)).toBeNull();

    write("app/orders.ts", "export const load = () => fetch('/orders');\n");
    expect(firstSourceMatching(dir, "typescript", FETCH)).toBe(
      path.join("app", "orders.ts"),
    );
  });

  it("leaves out a script the tsconfig includes", () => {
    write("tsconfig.json", JSON.stringify({ include: ["**/*.ts"] }));
    write("scripts/schema.ts", "await fetch('/schema');\n");
    write("orders.config.ts", "await fetch('/config');\n");
    expect(firstSourceMatching(dir, "typescript", FETCH)).toBeNull();
  });

  it("reads a Ruby project anywhere but its tooling and tests", () => {
    write("Gemfile", "source 'https://rubygems.org'\n");
    write("config/boot.rb", "Net::HTTP.get(URI('https://example.test'))\n");
    expect(firstSourceMatching(dir, "ruby", /Net::HTTP/)).toBeNull();

    write("lib/orders.rb", "Net::HTTP.get(URI('https://example.test'))\n");
    expect(firstSourceMatching(dir, "ruby", /Net::HTTP/)).toBe(
      path.join("lib", "orders.rb"),
    );
  });
});
