import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  loadStubs,
  stubDeprecationNote,
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

  it("routes a registration helper with the stub's package as its module", () => {
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
    const overlay = stubOverlayOf(loadStubs(root));
    expect(overlay.get("express")?.get("registrationHelpers")).toEqual([
      {
        helperName: "mountHealth",
        importModule: "@acme/http-kit",
        registrations: [
          { method: "GET", pathTemplate: "/health", handlerArg: "handler" },
        ],
      },
    ]);
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

describe("the deprecation note for stub-covered options", () => {
  it("points a configured option at the stub file", () => {
    const note = stubDeprecationNote("express", {
      registrationHelpers: [{ helperName: "mountHealth" }],
    });
    expect(note).toContain("registrationHelpers option on the express pack");
    expect(note).toContain("suss stub draft");
  });

  it("says nothing for uncovered options or packs", () => {
    expect(stubDeprecationNote("express", { otherOption: 1 })).toBeNull();
    expect(stubDeprecationNote("react", { anything: 1 })).toBeNull();
    expect(stubDeprecationNote("express", undefined)).toBeNull();
  });
});
