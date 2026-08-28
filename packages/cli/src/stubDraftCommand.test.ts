import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { draftYaml, stubDraft } from "./stubDraftCommand.js";
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
  it("writes a draft the stub loader can parse back", () => {
    const root = projectWith({ "src/ledger.ts": LEDGER_SOURCE });

    const code = stubDraft({ package: "@acme/ledger-native", dir: root });
    expect(code).toBe(0);

    const target = path.join(root, "suss", "stubs", "acme-ledger-native.yaml");
    expect(fs.existsSync(target)).toBe(true);

    const stubs = loadStubs(root);
    expect(stubs).toHaveLength(1);
    expect(stubs[0].package).toBe("@acme/ledger-native");
    expect(stubs[0].statements[0].kind).toBe("performs-call");
  });

  it("refuses to overwrite an existing stub", () => {
    const root = projectWith({
      "src/ledger.ts": LEDGER_SOURCE,
      "suss/stubs/acme-ledger-native.yaml": "package: x\n",
    });

    expect(() =>
      stubDraft({ package: "@acme/ledger-native", dir: root }),
    ).toThrow(/already exists/);
  });

  it("exits non-zero when the project never calls the package", () => {
    const root = projectWith({ "src/plain.ts": "export const a = 1;\n" });
    expect(stubDraft({ package: "@acme/ledger-native", dir: root })).toBe(1);
  });
});
