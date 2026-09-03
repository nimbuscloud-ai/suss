import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  loadStubs,
  stubOnlyOptionRefusal,
  stubOnlyOptionsOf,
  stubOverlayOf,
  withStubOptions,
} from "./stubs.js";

const created: string[] = [];

afterEach(() => {
  for (const dir of created.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function projectWith(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "suss-stubs-"));
  created.push(root);
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(root, "suss", "stubs", rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  }
  return root;
}

const DECORATOR_STUB = `
package: "@acme/http-kit"
authored: agent
statements:
  - kind: composes-decorator
    export: ApiController
    composes: { module: "@nestjs/common", name: Controller }
`;

describe("loading stubs", () => {
  it("reads yaml and json alike, sorted by file name", () => {
    const root = projectWith({
      "b.json": JSON.stringify({
        package: "@acme/native",
        statements: [
          {
            kind: "performs-call",
            export: "publishEntry",
            system: "aws.sqs",
            spec: { subject: { at: 0 } },
          },
        ],
      }),
      "a.yaml": DECORATOR_STUB,
    });

    const stubs = loadStubs(root);
    expect(stubs.map((one) => one.package)).toEqual([
      "@acme/http-kit",
      "@acme/native",
    ]);
  });

  it("says which file and field a bad stub failed on", () => {
    const root = projectWith({
      "bad.yaml": "package: x\nstatements:\n  - kind: nonsense\n",
    });
    expect(() => loadStubs(root)).toThrow(/bad\.yaml.*statements/s);
  });

  it("finds nothing where no stub directory exists", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "suss-nostubs-"));
    created.push(root);
    expect(loadStubs(root)).toEqual([]);
  });
});

describe("routing statements into pack options", () => {
  it("routes a composed decorator to both nestjs packs", () => {
    const root = projectWith({ "kit.yaml": DECORATOR_STUB });
    const overlay = stubOverlayOf(loadStubs(root));

    expect(overlay.get("nestjs-rest")?.get("classDecorators")).toEqual([
      "ApiController",
    ]);
    expect(overlay.get("nestjs-microservices")?.get("classDecorators")).toEqual(
      ["ApiController"],
    );
  });

  it("refuses a statement kind no pack consumes any more", () => {
    const root = projectWith({
      "kit.yaml": `
package: "@acme/http-kit"
statements:
  - kind: registers-routes
    export: mountHealth
    registrations:
      - { method: GET, pathTemplate: /health, handlerArg: handler }
`,
    });
    expect(() => loadStubs(root)).toThrow(/Invalid discriminator value/);
  });

  it("routes an extended base class and a re-exported module", () => {
    const root = projectWith({
      "wrap.yaml": `
package: acme_api
statements:
  - kind: extends-base
    class: BaseResolver
    extends: AcmeResolver
  - kind: re-exports
    of: fastapi
`,
    });
    const overlay = stubOverlayOf(loadStubs(root));
    expect(overlay.get("graphql-ruby")?.get("baseClassNames")).toEqual([
      "AcmeResolver",
    ]);
    expect(overlay.get("fastapi")?.get("wrapperModules")).toEqual(["acme_api"]);
  });

  it("drops statements no pack consumes", () => {
    const root = projectWith({
      "odd.yaml": `
package: acme_odd
statements:
  - kind: re-exports
    of: unknown_framework
  - kind: performs-call
    system: unknown.system
    spec: {}
`,
    });
    expect(stubOverlayOf(loadStubs(root)).size).toBe(0);
  });

  it("routes a performs-call to the pack for its system", () => {
    const root = projectWith({
      "native.yaml": `
package: "@acme/ledger-native"
statements:
  - kind: performs-call
    export: publishEntry
    system: aws.sqs
    spec: { subject: { at: 0 }, payload: { at: 1 } }
`,
    });
    const overlay = stubOverlayOf(loadStubs(root));
    expect(overlay.get("aws-sqs")?.get("producers")).toEqual([
      {
        module: "@acme/ledger-native",
        export: "publishEntry",
        subject: { at: 0 },
        payload: { at: 1 },
      },
    ]);
  });
});

describe("merging the overlay into a pack's options", () => {
  it("keeps hand-written entries first and appends the stub's", () => {
    const overlay = stubOverlayOf([
      {
        package: "@acme/http-kit",
        statements: [
          {
            kind: "composes-decorator",
            export: "ApiController",
            composes: { module: "@nestjs/common", name: "Controller" },
          },
        ],
      },
    ]);

    expect(
      withStubOptions(
        "nestjs-rest",
        { classDecorators: ["LegacyController"] },
        overlay,
      ),
    ).toEqual({ classDecorators: ["LegacyController", "ApiController"] });

    expect(withStubOptions("nestjs-rest", undefined, overlay)).toEqual({
      classDecorators: ["ApiController"],
    });

    expect(withStubOptions("express", { a: 1 }, overlay)).toEqual({ a: 1 });
  });
});

describe("the options only a stub may state", () => {
  it("lists them for a pack that has them, and nothing for one that does not", () => {
    expect(stubOnlyOptionsOf("nestjs-rest")).toEqual(["classDecorators"]);
    expect(stubOnlyOptionsOf("react")).toEqual([]);
  });

  it("leaves the options that describe the project's own code out", () => {
    expect(stubOnlyOptionsOf("express")).toEqual([]);
    expect(stubOnlyOptionsOf("aws-dynamodb")).toEqual([]);
    expect(stubOnlyOptionsOf("aws-lambda")).toEqual([]);
  });

  it("points one at the stub file, and reads as a sentence for two", () => {
    expect(stubOnlyOptionRefusal(["classDecorators"], "nestjs-rest")).toBe(
      "The classDecorators option describes a dependency, and a stub file in suss/stubs/ is where that now goes. " +
        "Start one with: suss infer stub <package>.",
    );
    expect(
      stubOnlyOptionRefusal(["producers", "factories"], "aws-sqs"),
    ).toContain("The producers and factories options describe a dependency");
  });

  it("shows the re-exports shape for wrapperModules, since matching is one stub per imported module", () => {
    const forFastapi = stubOnlyOptionRefusal(["wrapperModules"], "fastapi");
    expect(forFastapi).toContain("suss infer stub <package>");
    expect(forFastapi).toContain("kind: re-exports");
    expect(forFastapi).toContain("of: fastapi");
    expect(forFastapi).toContain(
      "package is the full module the project imports from",
    );

    const forFlaskRestx = stubOnlyOptionRefusal(
      ["wrapperModules"],
      "flask-restx",
    );
    expect(forFlaskRestx).toContain("of: flask_restx");
  });
});

describe("the drift note between a stub and the installed package", () => {
  function withInstalled(root: string, version: string): void {
    const dir = path.join(root, "node_modules", "@acme", "http-kit");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "@acme/http-kit", version }),
    );
  }

  function stubFrom(from: string): string {
    return `${DECORATOR_STUB}from: "${from}"\n`;
  }

  function stderrFrom(run: () => void): string {
    const chunks: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      run();
    } finally {
      process.stderr.write = original;
    }
    return chunks.join("");
  }

  it("points out a stub written from another version", () => {
    const root = projectWith({
      "kit.yaml": stubFrom("package source at 1.2.0"),
    });
    withInstalled(root, "1.4.2");

    const text = stderrFrom(() => loadStubs(root));
    expect(text).toContain("installed at 1.4.2");
    expect(text).toContain("written from 1.2.0");
  });

  it("says nothing when the versions agree or nothing is comparable", () => {
    const agreeing = projectWith({ "kit.yaml": stubFrom("source at 1.4.2") });
    withInstalled(agreeing, "1.4.2");
    expect(stderrFrom(() => loadStubs(agreeing))).toBe("");

    const noVersion = projectWith({ "kit.yaml": stubFrom("upstream docs") });
    withInstalled(noVersion, "1.4.2");
    expect(stderrFrom(() => loadStubs(noVersion))).toBe("");

    const notInstalled = projectWith({
      "kit.yaml": stubFrom("source at 1.2.0"),
    });
    expect(stderrFrom(() => loadStubs(notInstalled))).toBe("");
  });
});
