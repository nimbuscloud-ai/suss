import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadCloudFormationTemplate, refTarget } from "./templateLoader.js";

const tempFiles: string[] = [];

function writeTemp(name: string, content: string): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cfn-")), name);
  fs.writeFileSync(file, content);
  tempFiles.push(path.dirname(file));
  return file;
}

afterEach(() => {
  for (const dir of tempFiles.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("loadCloudFormationTemplate", () => {
  it("parses YAML templates and resolves intrinsic shorthand tags", () => {
    const file = writeTemp(
      "template.yaml",
      [
        "Resources:",
        "  Fn:",
        "    Type: AWS::Serverless::Function",
        "    Properties:",
        "      Role: !GetAtt FnRole.Arn",
        "      Queue: !Ref OrdersQueue",
        "      Name: !Sub 'svc-${AWS::Region}'",
      ].join("\n"),
    );
    const template = loadCloudFormationTemplate(file);
    const props = template.Resources?.Fn?.Properties as Record<string, unknown>;
    expect(props.Role).toEqual({ "Fn::GetAtt": ["FnRole", "Arn"] });
    expect(props.Queue).toEqual({ Ref: "OrdersQueue" });
    // Unhandled-value intrinsics collapse to their raw scalar.
    expect(props.Name).toBe("svc-${AWS::Region}");
  });

  it("resolves !GetAtt without a dot to a single-element path", () => {
    const file = writeTemp(
      "template.yaml",
      ["Resources:", "  R:", "    Properties:", "      X: !GetAtt Solo"].join(
        "\n",
      ),
    );
    const template = loadCloudFormationTemplate(file);
    const props = template.Resources?.R?.Properties as Record<string, unknown>;
    expect(props.X).toEqual({ "Fn::GetAtt": ["Solo"] });
  });

  it("parses .json templates as JSON", () => {
    const file = writeTemp(
      "template.json",
      JSON.stringify({ Resources: { Api: { Type: "AWS::Serverless::Api" } } }),
    );
    const template = loadCloudFormationTemplate(file);
    expect(template.Resources?.Api?.Type).toBe("AWS::Serverless::Api");
  });

  it("throws when the file is missing", () => {
    expect(() => loadCloudFormationTemplate("/nope/missing.yaml")).toThrow(
      /not found/,
    );
  });

  it("throws when the parsed value is not an object", () => {
    const file = writeTemp("template.yaml", "just a string");
    expect(() => loadCloudFormationTemplate(file)).toThrow(/not an object/);
  });
});

describe("refTarget", () => {
  it("returns bare strings as-is", () => {
    expect(refTarget("OrdersQueue")).toBe("OrdersQueue");
  });

  it("reads { Ref } objects", () => {
    expect(refTarget({ Ref: "OrdersQueue" })).toBe("OrdersQueue");
  });

  it("reads the logical id from Fn::GetAtt", () => {
    expect(refTarget({ "Fn::GetAtt": ["OrdersQueue", "Arn"] })).toBe(
      "OrdersQueue",
    );
  });

  it("returns null for unresolvable shapes", () => {
    expect(refTarget(null)).toBeNull();
    expect(refTarget(42)).toBeNull();
    expect(refTarget({ "Fn::GetAtt": [] })).toBeNull();
    expect(refTarget({ other: true })).toBeNull();
  });
});
