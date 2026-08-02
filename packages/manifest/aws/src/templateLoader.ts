// templateLoader.ts — parse a CloudFormation / SAM template file into a
// plain object, resolving the intrinsic YAML shorthand tags CFN uses.
//
// This is the one place that owns "turn a template on disk into data".
// Both the summary-generation paths in index.ts and the code-side
// handler pairing in serverlessFunctions.ts read through it, so the
// YAML/JSON parsing and the intrinsic-tag handling live here rather
// than being duplicated per consumer.

import fs from "node:fs";
import path from "node:path";

import YAML from "yaml";

export interface CloudFormationResource {
  Type?: string;
  Properties?: Record<string, unknown>;
  Metadata?: Record<string, unknown>;
}

export interface CloudFormationTemplate {
  /**
   * SAM `Globals` block. Section keys (`Function`, `Api`, `HttpApi`)
   * hold defaults that individual resources inherit unless they
   * override the property themselves.
   */
  Globals?: Record<string, Record<string, unknown>>;
  Resources?: Record<string, CloudFormationResource>;
}

// ---------------------------------------------------------------------------
// CloudFormation YAML intrinsic tags
// ---------------------------------------------------------------------------
//
// CloudFormation YAML uses shorthand tags (`!Ref X`, `!GetAtt X.Y`,
// `!Sub "..."`) that the default `yaml` schema doesn't know about. Without
// a handler the parser would either error or leave them as opaque tagged
// nodes. We register a small set covering the intrinsics that affect
// resource references — anything else collapses to its raw scalar value
// rather than failing the whole parse.

export const CLOUDFORMATION_YAML_TAGS = [
  {
    tag: "!Ref",
    resolve: (value: string) => ({ Ref: value }),
  },
  {
    tag: "!GetAtt",
    resolve: (value: string) => ({
      "Fn::GetAtt": value.includes(".") ? value.split(".") : [value],
    }),
  },
  ...[
    "!Sub",
    "!Join",
    "!Select",
    "!Split",
    "!FindInMap",
    "!ImportValue",
    "!Base64",
    "!Cidr",
    "!If",
    "!Not",
    "!And",
    "!Or",
    "!Equals",
  ].map((tag) => ({ tag, resolve: (value: unknown) => value })),
];

/**
 * Load a CloudFormation / SAM template from disk. Format is detected by
 * extension; `.json` parses as JSON, everything else (including
 * `.yaml` / `.yml` / `.template`) goes through the YAML parser with the
 * intrinsic tags registered.
 *
 * Throws when the file is missing or the parsed value isn't an object —
 * a malformed manifest is a load-time error, not a silent empty result.
 */
export function loadCloudFormationTemplate(
  templatePath: string,
): CloudFormationTemplate {
  const resolved = path.resolve(templatePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`CloudFormation template not found: ${resolved}`);
  }
  const raw = fs.readFileSync(resolved, "utf-8");
  const ext = path.extname(resolved).toLowerCase();
  const parsed: unknown =
    ext === ".json"
      ? JSON.parse(raw)
      : YAML.parse(raw, { customTags: CLOUDFORMATION_YAML_TAGS });
  if (parsed === null || typeof parsed !== "object") {
    throw new Error(`CloudFormation template is not an object: ${resolved}`);
  }
  return parsed as CloudFormationTemplate;
}

/**
 * CloudFormation references show up in four shapes after parsing:
 *   - { Ref: "LogicalId" }
 *   - { "Fn::GetAtt": ["LogicalId", "Attr"] }
 *   - { "Fn::GetAtt": "LogicalId.Attr" }, the full-form spelling of the
 *     `!GetAtt` short form, which templates written by hand still use
 *   - the bare logical id when the parser doesn't recognise the YAML tag
 *
 * Every CloudFormation property that names another resource accepts all
 * of them, so anything reading such a property should come through here
 * rather than matching one shape.
 */
export function refTarget(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (value === null || typeof value !== "object") {
    return null;
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.Ref === "string") {
    return obj.Ref;
  }
  const getAtt = obj["Fn::GetAtt"];
  if (Array.isArray(getAtt) && typeof getAtt[0] === "string") {
    return getAtt[0];
  }
  if (typeof getAtt === "string") {
    const dot = getAtt.indexOf(".");
    return dot === -1 ? getAtt : getAtt.slice(0, dot);
  }
  return null;
}
