import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { copyOfFixture, runSuss, writePackConfig } from "../harness.js";

/** A project with wrappers around its routes, and the files a test changes in it. */
interface Project {
  language: string;
  fixture: string;
  /** The extract arguments, given the copy of the fixture. */
  args: (dir: string) => string[];
  /** One more pack, which changes the cache's key. */
  extraPack: (dir: string) => string[];
  edit: { file: string; from: string; to: string };
  removed: string;
}

const PROJECTS: Project[] = [
  {
    language: "TypeScript",
    fixture: "wrapped-routes",
    // A project read without a tsconfig has nowhere to keep a cache.
    args: (dir) => {
      const tsconfig = path.join(dir, "tsconfig.json");
      fs.writeFileSync(
        tsconfig,
        JSON.stringify({
          compilerOptions: { strict: true, module: "esnext" },
          include: ["*.ts"],
        }),
      );
      return ["-p", tsconfig, "-f", "hono"];
    },
    extraPack: () => ["-f", "fetch"],
    edit: { file: "rateLimit.ts", from: "429", to: "503" },
    removed: "validationHook.ts",
  },
  {
    language: "Python",
    fixture: "wrapped-routes-fastapi",
    args: (dir) => ["--dir", dir, "-f", "fastapi"],
    extraPack: () => ["-f", "httpx"],
    edit: {
      file: "tenants_api/audit.py",
      from: '"events": []',
      to: '"events": [], "count": 0',
    },
    removed: "tenants_api/admin.py",
  },
  {
    language: "Ruby",
    fixture: "ruby-rails",
    args: (dir) => [
      "--dir",
      dir,
      "--lang",
      "ruby",
      "-f",
      `rails=${writePackConfig(dir, "rails", { root: "app", routesFile: "config/routes.rb" })}`,
    ],
    extraPack: (dir) => [
      "-f",
      `activerecord=${writePackConfig(dir, "activerecord", { storageSystem: "postgresql" })}`,
    ],
    edit: {
      file: "app/controllers/receipts_controller.rb",
      from: "respond_with_error(410)",
      to: "respond_with_error(404)",
    },
    removed: "app/controllers/admin/audits_controller.rb",
  },
];

interface Extract {
  written: string;
  cache: string;
}

function extract(args: string[], out: string, extra: string[] = []): Extract {
  const run = runSuss(["extract", ...args, "--timing", ...extra, "-o", out]);
  expect(run.status, run.stderr).toBe(0);
  return {
    written: fs.readFileSync(out, "utf8"),
    cache: run.stderr.split("\n").find((line) => line.includes("cache:")) ?? "",
  };
}

describe.each(PROJECTS)("the cache's store, in $language", (project) => {
  function setUp() {
    const dir = copyOfFixture(project.fixture, `store-${project.fixture}`);
    const out = path.join(path.dirname(dir), "out");
    fs.mkdirSync(out);
    const at = (name: string) => path.join(out, `${name}.json`);
    return { dir, args: project.args(dir), at };
  }

  it("gives back the cold run's export, byte for byte, assembled from its shards", () => {
    const { dir, args, at } = setUp();
    const cold = extract(args, at("cold"));
    const warm = extract(args, at("warm"));

    expect(cold.cache).toContain("cache: miss");
    expect(warm.cache).toContain("cache: hit");
    expect(JSON.parse(cold.written).length).toBeGreaterThan(0);
    expect(warm.written).toBe(cold.written);
    expect(
      fs.existsSync(path.join(dir, ".suss", "cache")) &&
        fs
          .readdirSync(path.join(dir, ".suss", "cache"), { recursive: true })
          .some((name) => String(name).endsWith("index.json")),
    ).toBe(true);
  });

  it("writes what a run without the cache writes after a file is edited", () => {
    const { dir, args, at } = setUp();
    extract(args, at("cold"));
    const edited = path.join(dir, project.edit.file);
    const text = fs.readFileSync(edited, "utf8");
    expect(text).toContain(project.edit.from);
    fs.writeFileSync(edited, text.replace(project.edit.from, project.edit.to));

    const after = extract(args, at("after"));
    const fresh = extract(args, at("fresh"), ["--no-cache"]);

    expect(after.cache).not.toContain("cache: hit");
    expect(after.written).toBe(fresh.written);
    expect(extract(args, at("again")).written).toBe(fresh.written);
  });

  it("writes what a run without the cache writes after a file is deleted", () => {
    const { dir, args, at } = setUp();
    extract(args, at("cold"));
    fs.rmSync(path.join(dir, project.removed));

    const after = extract(args, at("after"));
    const fresh = extract(args, at("fresh"), ["--no-cache"]);

    expect(after.written).toBe(fresh.written);
    expect(extract(args, at("again")).written).toBe(fresh.written);
  });

  it("starts over when the packs change", () => {
    const { dir, args, at } = setUp();
    extract(args, at("cold"));
    const more = [...args, ...project.extraPack(dir)];

    const after = extract(more, at("after"));
    const fresh = extract(more, at("fresh"), ["--no-cache"]);

    expect(after.cache).toContain("cache: miss (key-changed)");
    expect(after.written).toBe(fresh.written);
  });
});
