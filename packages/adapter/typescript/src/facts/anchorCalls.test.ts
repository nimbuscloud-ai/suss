import { Node } from "ts-morph";
import { describe, expect, it } from "vitest";

import { createTestProject } from "@suss/test-project";

import { ResolutionStore } from "./store.js";

const PACKAGE = "@probe/odm";

/**
 * The anchor calls behind the receiver of the last method call in the
 * fixture, filtered to `model(...)` the way a pack's origin check
 * would.
 */
function anchorTexts(files: Record<string, string>): string[] {
  const project = createTestProject();
  project.createSourceFile(
    `/node_modules/${PACKAGE}/package.json`,
    JSON.stringify({ name: PACKAGE, types: "index.d.ts" }),
  );
  project.createSourceFile(
    `/node_modules/${PACKAGE}/index.d.ts`,
    "export declare function model(name: string, schema?: unknown): any;\n",
  );
  for (const [path, content] of Object.entries(files)) {
    project.createSourceFile(path, content);
  }
  const consumer = project.getSourceFileOrThrow("/consumer.ts");
  const calls = consumer
    .getDescendants()
    .filter((node) => Node.isCallExpression(node));
  const last = calls[calls.length - 1];
  const callee = last?.getExpression();
  if (callee === undefined || !Node.isPropertyAccessExpression(callee)) {
    throw new Error("fixture's last call is not a method call");
  }

  const store = new ResolutionStore();
  return store
    .anchorCallsOf(callee.getExpression(), (call) => {
      if (!Node.isCallExpression(call)) {
        return false;
      }
      const anchorCallee = call.getExpression();
      return (
        Node.isIdentifier(anchorCallee) && anchorCallee.getText() === "model"
      );
    })
    .map((node) => node.getText());
}

describe("which model call anchors a receiver", () => {
  it("a static call on the model itself", () => {
    expect(
      anchorTexts({
        "/consumer.ts": `import { model } from "${PACKAGE}";\nconst User = model("User");\nexport const find = (id: string) => User.findById(id);\n`,
      }),
    ).toEqual(['model("User")']);
  });

  it("a construction of the model", () => {
    expect(
      anchorTexts({
        "/consumer.ts": `import { model } from "${PACKAGE}";\nconst User = model("User");\nconst doc = new User({ name: "a" });\nexport const save = () => doc.save();\n`,
      }),
    ).toEqual(['model("User")']);
  });

  it("a document a query returned", () => {
    expect(
      anchorTexts({
        "/consumer.ts": `import { model } from "${PACKAGE}";\nconst User = model("User");\nconst doc = User.findById("1");\nexport const save = () => doc.save();\n`,
      }),
    ).toEqual(['model("User")']);
  });

  it("a model built in another module", () => {
    expect(
      anchorTexts({
        "/models.ts": `import { model } from "${PACKAGE}";\nexport const User = model("User");\n`,
        "/consumer.ts": `import { User } from "./models.js";\nexport const find = (id: string) => User.findById(id);\n`,
      }),
    ).toEqual(['model("User")']);
  });

  it("a receiver with no model behind it", () => {
    expect(
      anchorTexts({
        "/consumer.ts":
          "const cache = { save: () => null };\nexport const save = () => cache.save();\n",
      }),
    ).toEqual([]);
  });
});
