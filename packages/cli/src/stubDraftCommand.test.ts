import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  draftPythonYaml,
  draftRubyYaml,
  draftYaml,
  stubDraft,
} from "./stubDraftCommand.js";
import { loadStubs } from "./stubs.js";

const created: string[] = [];

afterEach(() => {
  for (const dir of created.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function projectWith(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "suss-draft-"));
  created.push(root);
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  }
  return root;
}

const LEDGER_SOURCE = `
import { publishEntry } from "@acme/ledger-native";
export async function record(entry: object) {
  await publishEntry("ledger-queue", entry);
}
`;

describe("draftYaml", () => {
  it("writes one performs-call skeleton per export, with the evidence", () => {
    const yaml = draftYaml("@acme/ledger-native", [
      {
        exportPath: ["publishEntry"],
        calls: [
          {
            file: "src/ledger.ts",
            line: 4,
            args: [
              { kind: "string", value: "ledger-queue" },
              { kind: "identifier", name: "entry" },
            ],
          },
        ],
      },
    ]);

    expect(yaml).toContain('package: "@acme/ledger-native"');
    expect(yaml).toContain("# publishEntry: 1 call");
    expect(yaml).toContain('#   src/ledger.ts:4  ("ledger-queue", entry)');
    expect(yaml).toContain('export: "publishEntry"');
    expect(yaml).toContain('system: ""');
  });
});

describe("stubDraft", () => {
  it("writes a draft the stub loader can parse back", async () => {
    const root = projectWith({ "src/ledger.ts": LEDGER_SOURCE });

    const code = await stubDraft({ package: "@acme/ledger-native", dir: root });
    expect(code).toBe(0);

    const target = path.join(root, "suss", "stubs", "acme-ledger-native.yaml");
    expect(fs.existsSync(target)).toBe(true);

    const stubs = loadStubs(root);
    expect(stubs).toHaveLength(1);
    expect(stubs[0].package).toBe("@acme/ledger-native");
    expect(stubs[0].statements[0].kind).toBe("performs-call");
  });

  it("refuses to overwrite an existing stub", async () => {
    const root = projectWith({
      "src/ledger.ts": LEDGER_SOURCE,
      "suss/stubs/acme-ledger-native.yaml": "package: x\n",
    });

    await expect(
      stubDraft({ package: "@acme/ledger-native", dir: root }),
    ).rejects.toThrow(/already exists/);
  });

  it("exits non-zero when the project never calls the package", async () => {
    const root = projectWith({ "src/plain.ts": "export const a = 1;\n" });
    expect(await stubDraft({ package: "@acme/ledger-native", dir: root })).toBe(
      1,
    );
  });
});

describe("draftPythonYaml", () => {
  it("guesses the re-export target from the imported names, and leaves it blank when they disagree", () => {
    const flaskLike = draftPythonYaml("myapp.routing.namespace", {
      module: "myapp.routing.namespace",
      sites: [{ name: "Namespace", file: "app.py", line: 3 }],
    });
    expect(flaskLike).toContain('package: "myapp.routing.namespace"');
    expect(flaskLike).toContain("#   app.py:3  (Namespace)");
    expect(flaskLike).toContain("kind: re-exports");
    expect(flaskLike).toContain("of: flask_restx");

    const unknown = draftPythonYaml("myapp.routing.odd", {
      module: "myapp.routing.odd",
      sites: [{ name: "Something", file: "app.py", line: 1 }],
    });
    expect(unknown).toContain('of: ""');
    expect(unknown).toContain("fastapi, flask_restx");
  });
});

describe("draftRubyYaml", () => {
  it("fills class from an observed superclass outside graphql-ruby's own root classes, and leaves extends for the author", () => {
    const yaml = draftRubyYaml("acme_graphql", {
      requires: [],
      extendsSites: [
        {
          className: "Types::CampaignType",
          superclassName: "AcmeGraphql::AuthenticatedObject",
          file: "app/graphql/types/campaign_type.rb",
          line: 2,
        },
      ],
    });
    expect(yaml).toContain('package: "acme_graphql"');
    expect(yaml).toContain("kind: extends-base");
    expect(yaml).toContain('class: "AcmeGraphql::AuthenticatedObject"');
    expect(yaml).toContain('extends: ""');
    expect(yaml).toContain("GraphQL::Schema::Object");
  });

  it("drafts a blank statement from a require alone, with the known bases in a comment", () => {
    const yaml = draftRubyYaml("acme_graphql", {
      requires: [{ target: "acme_graphql", file: "Gemfile.rb", line: 1 }],
      extendsSites: [],
    });
    expect(yaml).toContain('class: ""');
    expect(yaml).toContain('extends: ""');
    expect(yaml).toContain("GraphQL::Schema::Object");
  });

  it("drafts a blank statement when the only class found extends a graphql-ruby root directly, since a stub cannot add to its ancestry", () => {
    const yaml = draftRubyYaml("graphql", {
      requires: [],
      extendsSites: [
        {
          className: "Types::CampaignType",
          superclassName: "GraphQL::Schema::Object",
          file: "app/graphql/types/campaign_type.rb",
          line: 2,
        },
      ],
    });
    expect(yaml).toContain('class: ""');
    expect(yaml).toContain('extends: ""');
    expect(yaml).toContain("extends a pack's own base directly");
    expect(yaml).toContain(
      "app/graphql/types/campaign_type.rb:2  (Types::CampaignType < GraphQL::Schema::Object)",
    );
  });

  it("drafts a blank statement when the only class found extends a Rails root directly", () => {
    const yaml = draftRubyYaml("actioncontroller-api", {
      requires: [],
      extendsSites: [
        {
          className: "ApplicationController",
          superclassName: "ActionController::API",
          file: "app/controllers/application_controller.rb",
          line: 1,
        },
      ],
    });
    expect(yaml).toContain("extends a pack's own base directly");
    expect(yaml).toContain(
      "app/controllers/application_controller.rb:1  (ApplicationController < ActionController::API)",
    );
  });
});

describe("stubDraft for a Python project", () => {
  it("drafts one stub per imported module the decorator matches exactly", async () => {
    const root = projectWith({
      "app.py":
        "from myapp.routing.namespace import Namespace\n" +
        "from myapp.routing.resource import Resource\n",
    });

    const code = await stubDraft({ package: "myapp", dir: root });
    expect(code).toBe(0);

    const namespace = path.join(
      root,
      "suss",
      "stubs",
      "myapp-routing-namespace.yaml",
    );
    const resource = path.join(
      root,
      "suss",
      "stubs",
      "myapp-routing-resource.yaml",
    );
    expect(fs.existsSync(namespace)).toBe(true);
    expect(fs.existsSync(resource)).toBe(true);

    const stubs = loadStubs(root);
    expect(stubs.map((one) => one.package).sort()).toEqual([
      "myapp.routing.namespace",
      "myapp.routing.resource",
    ]);
  });

  it("exits non-zero when the project never imports the package", async () => {
    const root = projectWith({ "app.py": "x = 1\n" });
    expect(await stubDraft({ package: "myapp", dir: root })).toBe(1);
  });
});

describe("stubDraft for a Ruby project", () => {
  it("drafts an extends-base stub from a class extending a wrapper gem's own class", async () => {
    const root = projectWith({
      Gemfile: 'gem "graphql"\ngem "acme_graphql"\n',
      "app/graphql/types/campaign_type.rb":
        "module Types\n  class CampaignType < AcmeGraphql::AuthenticatedObject\n  end\nend\n",
    });

    const code = await stubDraft({ package: "acme_graphql", dir: root });
    expect(code).toBe(0);

    const target = path.join(root, "suss", "stubs", "acme-graphql.yaml");
    expect(fs.existsSync(target)).toBe(true);

    const stubs = loadStubs(root);
    expect(stubs).toHaveLength(1);
    expect(stubs[0].statements[0]).toMatchObject({
      kind: "extends-base",
      class: "AcmeGraphql::AuthenticatedObject",
      extends: "",
    });
  });

  it("drafts a blank statement, rather than an inert one, when the only class found extends graphql-ruby's own root class directly", async () => {
    const root = projectWith({
      Gemfile: 'gem "graphql"\n',
      "app/graphql/types/campaign_type.rb":
        "module Types\n  class CampaignType < GraphQL::Schema::Object\n  end\nend\n",
    });

    const code = await stubDraft({ package: "graphql", dir: root });
    expect(code).toBe(0);

    const stubs = loadStubs(root);
    expect(stubs[0].statements[0]).toMatchObject({
      kind: "extends-base",
      class: "",
      extends: "",
    });
  });
});
