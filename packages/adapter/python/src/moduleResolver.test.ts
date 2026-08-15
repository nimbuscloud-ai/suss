import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  resolveAbsoluteModule,
  resolveModule,
  resolveRelativeModule,
} from "./moduleResolver.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-python-resolver-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function write(relPath: string, content = ""): void {
  const full = path.join(tmpDir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

describe("resolveAbsoluteModule", () => {
  it("resolves a dotted module to a plain .py file under one root", () => {
    write("root/myapp/wrappers/restx.py");
    const result = resolveAbsoluteModule("myapp.wrappers.restx", {
      roots: [path.join(tmpDir, "root")],
    });
    expect(result).toEqual({
      status: "resolved",
      file: path.join(tmpDir, "root/myapp/wrappers/restx.py"),
    });
  });

  it("resolves a dotted module to a package's __init__.py", () => {
    write("root/myapp/wrappers/__init__.py");
    const result = resolveAbsoluteModule("myapp.wrappers", {
      roots: [path.join(tmpDir, "root")],
    });
    expect(result).toEqual({
      status: "resolved",
      file: path.join(tmpDir, "root/myapp/wrappers/__init__.py"),
    });
  });

  it("abstains as external when no configured root names the module", () => {
    const result = resolveAbsoluteModule("flask_restx", {
      roots: [path.join(tmpDir, "root")],
    });
    expect(result).toEqual({ status: "unresolved", reason: "external" });
  });

  it("abstains as ambiguous when more than one root names the module", () => {
    write("src/myapp/models.py");
    write("vendor/myapp/models.py");
    const result = resolveAbsoluteModule("myapp.models", {
      roots: [path.join(tmpDir, "src"), path.join(tmpDir, "vendor")],
    });
    expect(result).toEqual({ status: "unresolved", reason: "ambiguous" });
  });

  it("does not treat the same module found via two candidate forms under one root as ambiguous", () => {
    write("root/myapp/wrappers/restx.py");
    const result = resolveAbsoluteModule("myapp.wrappers.restx", {
      roots: [path.join(tmpDir, "root")],
    });
    expect(result.status).toBe("resolved");
  });
});

describe("resolveRelativeModule", () => {
  it("resolves a level-1 import against the importing file's own directory", () => {
    write("myapp/routes/wrapper.py");
    write("myapp/routes/todos.py");
    const result = resolveRelativeModule(
      path.join(tmpDir, "myapp/routes/todos.py"),
      { module: "wrapper", relativeLevel: 1 },
      { roots: [tmpDir] },
    );
    expect(result).toEqual({
      status: "resolved",
      file: path.join(tmpDir, "myapp/routes/wrapper.py"),
    });
  });

  it("resolves a bare `from . import x` to the containing package's __init__.py", () => {
    write("myapp/routes/__init__.py");
    write("myapp/routes/todos.py");
    const result = resolveRelativeModule(
      path.join(tmpDir, "myapp/routes/todos.py"),
      { module: "", relativeLevel: 1 },
      { roots: [tmpDir] },
    );
    expect(result).toEqual({
      status: "resolved",
      file: path.join(tmpDir, "myapp/routes/__init__.py"),
    });
  });

  it("resolves a level-2 import one directory further up", () => {
    write("myapp/shared.py");
    write("myapp/routes/todos.py");
    const result = resolveRelativeModule(
      path.join(tmpDir, "myapp/routes/todos.py"),
      { module: "shared", relativeLevel: 2 },
      { roots: [tmpDir] },
    );
    expect(result).toEqual({
      status: "resolved",
      file: path.join(tmpDir, "myapp/shared.py"),
    });
  });

  it("abstains as external when the relative target doesn't exist", () => {
    write("myapp/routes/todos.py");
    const result = resolveRelativeModule(
      path.join(tmpDir, "myapp/routes/todos.py"),
      { module: "missing", relativeLevel: 1 },
      { roots: [tmpDir] },
    );
    expect(result).toEqual({ status: "unresolved", reason: "external" });
  });

  it("resolves when the walk lands exactly on a configured root (inclusive boundary)", () => {
    write("proj/__init__.py");
    write("proj/myapp/routes/todos.py");
    const result = resolveRelativeModule(
      path.join(tmpDir, "proj/myapp/routes/todos.py"),
      { module: "", relativeLevel: 3 },
      { roots: [path.join(tmpDir, "proj")] },
    );
    expect(result).toEqual({
      status: "resolved",
      file: path.join(tmpDir, "proj/__init__.py"),
    });
  });

  it("abstains rather than answering with a file outside every configured root, on a too-deep relative import", () => {
    const root = path.join(tmpDir, "proj");
    write("proj/myapp/routes/todos.py");
    write("sibling.py");
    const result = resolveRelativeModule(
      path.join(tmpDir, "proj/myapp/routes/todos.py"),
      { module: "sibling", relativeLevel: 4 },
      { roots: [root] },
    );
    expect(result).toEqual({ status: "unresolved", reason: "outsideRoots" });
  });

  it("abstains immediately when the importing file itself is outside every configured root", () => {
    write("outside/todos.py");
    const result = resolveRelativeModule(
      path.join(tmpDir, "outside/todos.py"),
      { module: "wrapper", relativeLevel: 1 },
      { roots: [path.join(tmpDir, "proj")] },
    );
    expect(result).toEqual({ status: "unresolved", reason: "outsideRoots" });
  });
});

describe("resolveModule", () => {
  it("dispatches to the relative resolver when the spec carries dots", () => {
    write("myapp/routes/wrapper.py");
    write("myapp/routes/todos.py");
    const result = resolveModule(
      path.join(tmpDir, "myapp/routes/todos.py"),
      { module: "wrapper", relativeLevel: 1 },
      { roots: [tmpDir] },
    );
    expect(result.status).toBe("resolved");
  });

  it("dispatches to the absolute resolver when the spec has no dots", () => {
    write("root/flask_restx.py");
    const result = resolveModule(
      path.join(tmpDir, "anywhere.py"),
      { module: "flask_restx", relativeLevel: 0 },
      { roots: [path.join(tmpDir, "root")] },
    );
    expect(result.status).toBe("resolved");
  });
});

describe("resolveAbsoluteModule: casing", () => {
  it("abstains on a wrongly-cased import instead of resolving on a case-keeping filesystem", () => {
    write("root/myapp/orders.py");
    const result = resolveAbsoluteModule("myapp.Orders", {
      roots: [path.join(tmpDir, "root")],
    });
    expect(result).toEqual({ status: "unresolved", reason: "external" });
  });

  it("abstains when a directory segment's casing is wrong", () => {
    write("root/myapp/wrappers/restx.py");
    const result = resolveAbsoluteModule("Myapp.wrappers.restx", {
      roots: [path.join(tmpDir, "root")],
    });
    expect(result).toEqual({ status: "unresolved", reason: "external" });
  });
});
