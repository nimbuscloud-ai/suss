import { Project } from "ts-morph";
import { describe, expect, it } from "vitest";

import { stubEvidenceIn } from "./stubEvidence.js";

function projectWith(files: Record<string, string>): Project {
  const project = new Project({ useInMemoryFileSystem: true });
  for (const [file, text] of Object.entries(files)) {
    project.createSourceFile(file, text);
  }
  return project;
}

describe("stubEvidenceIn", () => {
  it("groups call sites by the export they reach, with argument shapes", () => {
    const project = projectWith({
      "/src/ledger.ts": `
import { publishEntry } from "@acme/ledger-native";
export async function record(entry: object) {
  await publishEntry("ledger-queue", entry);
}
export async function replay(entries: object[]) {
  for (const one of entries) {
    await publishEntry("replay-queue", one);
  }
}
`,
    });

    const evidence = stubEvidenceIn(project, "@acme/ledger-native", "/");
    expect(evidence).toHaveLength(1);
    expect(evidence[0].exportPath).toEqual(["publishEntry"]);
    expect(evidence[0].calls).toHaveLength(2);
    expect(evidence[0].calls[0]).toEqual({
      file: "src/ledger.ts",
      line: 4,
      args: [
        { kind: "string", value: "ledger-queue" },
        { kind: "identifier", name: "entry" },
      ],
    });
  });

  it("walks a method on a factory result to the factory's export", () => {
    const project = projectWith({
      "/src/client.ts": `
import { createClient } from "@acme/kit";
export function fetchUser(id: string) {
  const client = createClient({ retries: 2 });
  return client.getUser(id);
}
`,
    });

    const evidence = stubEvidenceIn(project, "@acme/kit", "/");
    const paths = evidence.map((one) => one.exportPath.join("."));
    expect(paths).toContain("createClient");
    expect(paths).toContain("createClient.getUser");
  });

  it("ignores calls into other packages and declaration files", () => {
    const project = projectWith({
      "/src/other.ts": `
import { send } from "@other/pkg";
export function go() {
  return send("x");
}
`,
      "/types/kit.d.ts": `
declare module "@acme/kit" { export function helper(): void; }
`,
    });

    expect(stubEvidenceIn(project, "@acme/kit", "/")).toEqual([]);
  });
});
