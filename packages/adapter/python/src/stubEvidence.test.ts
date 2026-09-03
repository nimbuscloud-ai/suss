import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { pythonImportEvidence } from "./stubEvidence.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-python-stub-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function write(relPath: string, content: string): void {
  const full = path.join(tmpDir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

describe("pythonImportEvidence", () => {
  it("groups every import of the package or a submodule by the exact module text", async () => {
    write(
      "app.py",
      "from myapp.routing.namespace import Namespace\n" +
        "from myapp.routing.resource import Resource\n" +
        "from myapp.routing.namespace import fields\n",
    );

    const evidence = await pythonImportEvidence({
      packageName: "myapp",
      directory: tmpDir,
    });

    expect(evidence.map((one) => one.module)).toEqual([
      "myapp.routing.namespace",
      "myapp.routing.resource",
    ]);
    const namespace = evidence[0];
    expect(namespace.sites.map((site) => site.name)).toEqual([
      "Namespace",
      "fields",
    ]);
    expect(namespace.sites[0].line).toBe(1);
  });

  it("leaves out an unrelated import and a relative one", async () => {
    write(
      "app.py",
      "import flask_restx\n" +
        "from . import routes\n" +
        "from other.pkg import Thing\n",
    );

    const evidence = await pythonImportEvidence({
      packageName: "myapp",
      directory: tmpDir,
    });

    expect(evidence).toEqual([]);
  });

  it("records a bare `import module` with no attribute name", async () => {
    write("app.py", "import myapp.routing.namespace\n");

    const evidence = await pythonImportEvidence({
      packageName: "myapp",
      directory: tmpDir,
    });

    expect(evidence).toHaveLength(1);
    expect(evidence[0].module).toBe("myapp.routing.namespace");
    expect(evidence[0].sites[0].name).toBeNull();
  });
});
