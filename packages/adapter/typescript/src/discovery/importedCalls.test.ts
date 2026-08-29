import { describe, expect, it } from "vitest";

import { createTestProject } from "@suss/test-project";

import { ResolutionStore } from "../facts/store.js";
import { callsResolvingTo } from "./importedCalls.js";

const PACKAGE = "@probe/server";

function matchedCallTexts(files: Record<string, string>): string[] {
  const project = createTestProject();
  project.createSourceFile(
    `/node_modules/${PACKAGE}/package.json`,
    JSON.stringify({ name: PACKAGE, types: "index.d.ts" }),
  );
  project.createSourceFile(
    `/node_modules/${PACKAGE}/index.d.ts`,
    "export declare class ApolloServer { constructor(config: unknown); }\n",
  );
  for (const [path, content] of Object.entries(files)) {
    project.createSourceFile(path, content);
  }
  const store = new ResolutionStore();
  return callsResolvingTo(project.getSourceFileOrThrow("/consumer.ts"), store, {
    module: PACKAGE,
    name: "ApolloServer",
  }).map((call) => call.getText());
}

describe("which calls resolve to a module's export", () => {
  it("a direct import, called or constructed", () => {
    expect(
      matchedCallTexts({
        "/consumer.ts": `import { ApolloServer } from "${PACKAGE}";\nnew ApolloServer({});\nApolloServer({});\n`,
      }),
    ).toEqual(["new ApolloServer({})", "ApolloServer({})"]);
  });

  it("an aliased import", () => {
    expect(
      matchedCallTexts({
        "/consumer.ts": `import { ApolloServer as Srv } from "${PACKAGE}";\nnew Srv({});\n`,
      }),
    ).toEqual(["new Srv({})"]);
  });

  it("an import through a project barrel", () => {
    expect(
      matchedCallTexts({
        "/barrel.ts": `export { ApolloServer } from "${PACKAGE}";\n`,
        "/consumer.ts": `import { ApolloServer } from "./barrel.js";\nnew ApolloServer({});\n`,
      }),
    ).toEqual(["new ApolloServer({})"]);
  });

  it("a local function spelled the same is not the import", () => {
    expect(
      matchedCallTexts({
        "/consumer.ts":
          "function ApolloServer(config: unknown) {}\nApolloServer({});\n",
      }),
    ).toEqual([]);
  });
});
