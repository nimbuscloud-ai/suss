import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { generatedClientInputs } from "./generatedClient.js";

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function projectOf(files: Record<string, string>): string {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "suss-prisma-inputs-")),
  );
  roots.push(root);
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  return root;
}

const relativeTo = (root: string, files: string[]): string[] =>
  files
    .filter((file) => fs.existsSync(file))
    .map((file) => path.relative(root, file));

describe("the files the Prisma pack reads outside the walked sources", () => {
  it("are the schema and the type files of a client written to node_modules", () => {
    const root = projectOf({
      "package.json": "{}",
      "prisma/schema.prisma":
        'generator client {\n  provider = "prisma-client-js"\n}\n',
      "src/db.ts": "export {};\n",
      "node_modules/.prisma/client/index.d.ts": "export {};\n",
      "node_modules/.prisma/client/index.js": "",
      "node_modules/.prisma/client/schema.prisma": "",
      "node_modules/.prisma/client/package.json": "{}",
      "node_modules/.prisma/client/runtime/library.d.ts": "export {};\n",
      "node_modules/.prisma/client/libquery_engine.dylib.node": "",
    });

    expect(
      relativeTo(root, generatedClientInputs([path.join(root, "src/db.ts")])),
    ).toEqual([
      "node_modules/.prisma/client/index.d.ts",
      "node_modules/.prisma/client/package.json",
      "node_modules/.prisma/client/schema.prisma",
      "package.json",
      "prisma/schema.prisma",
    ]);
  });

  it("are the files under a generator's own output, at any depth", () => {
    const root = projectOf({
      "package.json": "{}",
      "schema.prisma":
        'generator client {\n  provider = "prisma-client"\n  output = "./generated/prisma"\n}\n',
      "src/db.ts": "export {};\n",
      "generated/prisma/client.ts": "export {};\n",
      "generated/prisma/models/User.ts": "export {};\n",
    });

    const inputs = relativeTo(
      root,
      generatedClientInputs([path.join(root, "src/db.ts")]),
    );

    expect(inputs).toEqual(
      expect.arrayContaining([
        "generated/prisma/client.ts",
        "generated/prisma/models/User.ts",
        "schema.prisma",
      ]),
    );
  });

  it("are none for files in no project", () => {
    expect(generatedClientInputs([])).toEqual([]);
  });
});
