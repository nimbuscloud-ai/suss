import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resourcesWithGlobals } from "./globals.js";
import {
  loadTemplateTree,
  MAX_STACK_DEPTH,
  qualifiedLogicalId,
  unfollowedStackMessage,
} from "./nestedStacks.js";

const tempDirs: string[] = [];

/** Write a directory of templates and return the root's path. */
function writeTemplates(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cfn-nested-"));
  tempDirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return path.join(dir, "template.yaml");
}

function stack(logicalId: string, url: string): string {
  return [
    `  ${logicalId}:`,
    "    Type: AWS::CloudFormation::Stack",
    "    Properties:",
    `      TemplateURL: ${url}`,
  ].join("\n");
}

function fn(logicalId: string, handler: string): string {
  return [
    `  ${logicalId}:`,
    "    Type: AWS::Serverless::Function",
    "    Properties:",
    `      Handler: ${handler}`,
  ].join("\n");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("loadTemplateTree", () => {
  it("reads the templates a stack resource names, and the ones they name", () => {
    const root = writeTemplates({
      "template.yaml": ["Resources:", stack("Child", "./child.yaml")].join(
        "\n",
      ),
      "child.yaml": [
        "Resources:",
        fn("ChildFunction", "src/child.handler"),
        stack("GrandChild", "./nested/grand.yaml"),
      ].join("\n"),
      "nested/grand.yaml": [
        "Resources:",
        fn("GrandFunction", "src/grand.handler"),
      ].join("\n"),
    });

    const tree = loadTemplateTree(root);

    expect(tree.unfollowed).toEqual([]);
    expect(tree.documents.map((d) => d.stackPath)).toEqual([
      [],
      ["Child"],
      ["Child", "GrandChild"],
    ]);
    expect(Object.keys(tree.documents[2].template.Resources ?? {})).toEqual([
      "GrandFunction",
    ]);
  });

  it("resolves a child's path against the document that names it", () => {
    const root = writeTemplates({
      "template.yaml": [
        "Resources:",
        stack("Child", "./stacks/child.yaml"),
      ].join("\n"),
      "stacks/child.yaml": [
        "Resources:",
        stack("GrandChild", "./grand.yaml"),
      ].join("\n"),
      "stacks/grand.yaml": ["Resources:", fn("F", "src/f.handler")].join("\n"),
    });

    const tree = loadTemplateTree(root);

    expect(tree.unfollowed).toEqual([]);
    expect(tree.documents).toHaveLength(3);
  });

  it("follows the SAM spelling of the same relationship", () => {
    const root = writeTemplates({
      "template.yaml": [
        "Resources:",
        "  Child:",
        "    Type: AWS::Serverless::Application",
        "    Properties:",
        "      Location: ./child.yaml",
      ].join("\n"),
      "child.yaml": ["Resources:", fn("F", "src/f.handler")].join("\n"),
    });

    expect(loadTemplateTree(root).documents).toHaveLength(2);
  });

  it("applies each document's Globals to that document only", () => {
    const root = writeTemplates({
      "template.yaml": [
        "Globals:",
        "  Function:",
        "    Environment:",
        "      Variables:",
        "        ROOT_ONLY: yes",
        "Resources:",
        fn("RootFunction", "src/root.handler"),
        stack("Child", "./child.yaml"),
      ].join("\n"),
      "child.yaml": [
        "Globals:",
        "  Function:",
        "    Environment:",
        "      Variables:",
        "        CHILD_ONLY: yes",
        "Resources:",
        fn("ChildFunction", "src/child.handler"),
      ].join("\n"),
    });

    const tree = loadTemplateTree(root);
    const envOf = (index: number, logicalId: string): string[] => {
      const properties = resourcesWithGlobals(tree.documents[index].template)[
        logicalId
      ]?.Properties as { Environment?: { Variables?: Record<string, string> } };
      return Object.keys(properties?.Environment?.Variables ?? {});
    };

    expect(envOf(0, "RootFunction")).toEqual(["ROOT_ONLY"]);
    expect(envOf(1, "ChildFunction")).toEqual(["CHILD_ONLY"]);
  });

  it("reports a location no repository read can reach", () => {
    const root = writeTemplates({
      "template.yaml": [
        "Resources:",
        stack("Packaged", "s3://artifacts/packaged.yaml"),
      ].join("\n"),
    });

    const tree = loadTemplateTree(root);

    expect(tree.documents).toHaveLength(1);
    expect(tree.unfollowed).toHaveLength(1);
    expect(tree.unfollowed[0]).toMatchObject({
      reason: "remoteUrl",
      stackPath: ["Packaged"],
      templateUrl: "s3://artifacts/packaged.yaml",
    });
  });

  it("reports a child that is not on disk", () => {
    const root = writeTemplates({
      "template.yaml": ["Resources:", stack("Missing", "./gone.yaml")].join(
        "\n",
      ),
    });

    const tree = loadTemplateTree(root);

    expect(tree.unfollowed).toHaveLength(1);
    expect(tree.unfollowed[0].reason).toBe("fileMissing");
    expect(unfollowedStackMessage(tree.unfollowed[0])).toContain(
      "./gone.yaml is not on disk",
    );
    // The file a caller watches for, so the day somebody writes it the
    // read is done again.
    expect(tree.unfollowed[0].templatePath).toBe(
      path.join(path.dirname(root), "gone.yaml"),
    );
  });

  it("leaves a remote child no path in this repository to watch", () => {
    const root = writeTemplates({
      "template.yaml": [
        "Resources:",
        stack("Packaged", "s3://artifacts/packaged.yaml"),
      ].join("\n"),
    });

    expect(loadTemplateTree(root).unfollowed[0].templatePath).toBeNull();
  });

  it("reports a child whose location is computed rather than written", () => {
    const root = writeTemplates({
      "template.yaml": [
        "Resources:",
        "  Computed:",
        "    Type: AWS::CloudFormation::Stack",
        "    Properties:",
        "      TemplateURL: !Sub '${Bucket}/child.yaml'",
        "  NoLocation:",
        "    Type: AWS::CloudFormation::Stack",
        "    Properties: {}",
      ].join("\n"),
    });

    const tree = loadTemplateTree(root);

    expect(tree.unfollowed.map((u) => u.reason)).toEqual([
      "notALiteralPath",
      "notALiteralPath",
    ]);
  });

  it("reports a child that does not parse", () => {
    const root = writeTemplates({
      "template.yaml": ["Resources:", stack("Broken", "./broken.yaml")].join(
        "\n",
      ),
      "broken.yaml": "just a string",
    });

    const tree = loadTemplateTree(root);

    expect(tree.unfollowed[0].reason).toBe("unreadable");
  });

  it("stops at a child that embeds a document already open above it", () => {
    const root = writeTemplates({
      "template.yaml": ["Resources:", stack("Child", "./child.yaml")].join(
        "\n",
      ),
      "child.yaml": [
        "Resources:",
        fn("ChildFunction", "src/child.handler"),
        stack("BackToRoot", "./template.yaml"),
      ].join("\n"),
    });

    const tree = loadTemplateTree(root);

    expect(tree.documents).toHaveLength(2);
    expect(tree.unfollowed).toHaveLength(1);
    expect(tree.unfollowed[0]).toMatchObject({
      reason: "cycle",
      stackPath: ["Child", "BackToRoot"],
    });
  });

  it("reads the same document twice when two stacks embed it", () => {
    const root = writeTemplates({
      "template.yaml": [
        "Resources:",
        stack("Left", "./shared.yaml"),
        stack("Right", "./shared.yaml"),
      ].join("\n"),
      "shared.yaml": ["Resources:", fn("F", "src/f.handler")].join("\n"),
    });

    const tree = loadTemplateTree(root);

    // Two stack resources deploy two copies of the resources, so both
    // are read, and the stack path is what tells the copies apart.
    expect(tree.documents.map((d) => d.stackPath)).toEqual([
      [],
      ["Left"],
      ["Right"],
    ]);
  });

  it("stops at a chain deeper than the limit and says so", () => {
    const files: Record<string, string> = {};
    const depth = MAX_STACK_DEPTH + 2;
    files["template.yaml"] = ["Resources:", stack("S0", "./child0.yaml")].join(
      "\n",
    );
    for (let i = 0; i < depth; i += 1) {
      files[`child${i}.yaml`] = [
        "Resources:",
        stack(`S${i + 1}`, `./child${i + 1}.yaml`),
      ].join("\n");
    }
    files[`child${depth}.yaml`] = "Resources: {}";

    const tree = loadTemplateTree(writeTemplates(files));

    expect(tree.documents).toHaveLength(MAX_STACK_DEPTH + 1);
    expect(tree.unfollowed).toHaveLength(1);
    expect(tree.unfollowed[0].reason).toBe("depthLimit");
  });

  it("throws when the root itself is not there", () => {
    expect(() => loadTemplateTree("/nowhere/template.yaml")).toThrow(
      /not found/,
    );
  });
});

describe("qualifiedLogicalId", () => {
  it("leaves a root resource its bare id", () => {
    expect(qualifiedLogicalId([], "HandlerFunction")).toBe("HandlerFunction");
  });

  it("tells two documents' resources of the same name apart", () => {
    expect(qualifiedLogicalId(["OrdersStack"], "HandlerFunction")).not.toBe(
      qualifiedLogicalId(["BillingStack"], "HandlerFunction"),
    );
  });
});
