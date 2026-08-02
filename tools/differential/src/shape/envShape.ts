// envShape.ts: where a unit reads its runtime configuration, and how
// that read is spelled.
//
// A deployable unit's env vars are a contract: whoever deploys it has
// to supply them. The node runtime pack finds those reads by walking
// the units another pack discovered, so the same read moves in and out
// of view depending on where in the module it sits. That is the
// dimension here. The second one is spelling, where a read means the
// same thing however it is written: a property, an index, or a
// destructuring off `process.env`.

import { type DispatchTable, dispatchByType } from "../dispatch.js";

/** Where in the module the read sits. */
export type ReadSite =
  | "inBody"
  | "inGuard"
  | "inNestedArrow"
  | "inLocalHelper"
  | "inImportedHelper"
  | "atModuleScope";

/** How the read off `process.env` is written. */
export type ReadForm = "dotted" | "bracket" | "defaulted" | "destructured";

export interface EnvShapeSpec {
  site: ReadSite;
  form: ReadForm;
  /** The variable the program reads, which the oracle expects back. */
  varName: string;
}

/** One read the program makes, which some summary has to report. */
export interface ExpectedConfigRead {
  name: string;
  defaulted: boolean;
}

export interface RenderedEnvShape {
  files: Record<string, string>;
  reads: ExpectedConfigRead[];
}

// The plainest spelling: the read written as a property, in the
// handler's own body, where the pack looks first.
export const SIMPLEST_ENV_SHAPE: Omit<EnvShapeSpec, "varName"> = {
  site: "inBody",
  form: "dotted",
};

export const ENV_ENTRY_FILE = "/generated/entry.ts";
const HELPER_FILE = "/generated/config.ts";
const ROUTE_PATH = "/generated";
const VALUE = "value";

/** The statements that perform the read and leave it in `value`. */
function readStatements(spec: EnvShapeSpec): string[] {
  const table: DispatchTable<{ type: ReadForm }, string[]> = {
    dotted: () => [`const ${VALUE} = process.env.${spec.varName};`],
    bracket: () => [
      `const ${VALUE} = process.env[${JSON.stringify(spec.varName)}];`,
    ],
    defaulted: () => [
      `const ${VALUE} = process.env.${spec.varName} ?? "fallback";`,
    ],
    destructured: () => [`const { ${spec.varName}: ${VALUE} } = process.env;`],
  };
  return dispatchByType(table, { type: spec.form });
}

const indentBy = (lines: string[], by: string): string[] =>
  lines.map((line) => `${by}${line}`);

interface SiteRendering {
  /** Lines above the router, at module scope. */
  moduleLines: string[];
  /** The handler body, already indented one level. */
  bodyLines: string[];
  /** A second file, when the read lives in one. */
  extraFiles: Record<string, string>;
  imports: string[];
}

const respond = (expression: string): string =>
  `res.status(200).json({ ok: ${expression} });`;

function siteRenderings(
  spec: EnvShapeSpec,
): DispatchTable<{ type: ReadSite }, SiteRendering> {
  const read = readStatements(spec);
  const bare = (bodyLines: string[]): SiteRendering => ({
    moduleLines: [],
    bodyLines,
    extraFiles: {},
    imports: [],
  });
  // A helper both helper sites share, so the two differ only in which
  // file holds it.
  const helperLines = [
    "export const readConfig = () => {",
    ...indentBy(read, "  "),
    `  return ${VALUE};`,
    "};",
  ];

  return {
    inBody: () => bare([...read, respond(VALUE)]),
    inGuard: () =>
      bare([
        "if (req.query.wanted) {",
        ...indentBy([...read, respond(VALUE)], "  "),
        "  return;",
        "}",
        respond('"none"'),
      ]),
    inNestedArrow: () =>
      bare([
        "const values = [1].map(() => {",
        ...indentBy(read, "  "),
        `  return ${VALUE};`,
        "});",
        respond("values[0]"),
      ]),
    inLocalHelper: () => ({
      moduleLines: helperLines,
      bodyLines: [respond("readConfig()")],
      extraFiles: {},
      imports: [],
    }),
    inImportedHelper: () => ({
      moduleLines: [],
      bodyLines: [respond("readConfig()")],
      extraFiles: { [HELPER_FILE]: `${helperLines.join("\n")}\n` },
      imports: ['import { readConfig } from "./config.js";'],
    }),
    atModuleScope: () => ({
      moduleLines: read,
      bodyLines: [respond(VALUE)],
      extraFiles: {},
      imports: [],
    }),
  };
}

export function renderEnvShape(spec: EnvShapeSpec): RenderedEnvShape {
  const site = dispatchByType(siteRenderings(spec), { type: spec.site });
  const entry = [
    'import { Router } from "express";',
    ...site.imports,
    "",
    "const router = Router();",
    "",
    ...site.moduleLines,
    "",
    `router.get(${JSON.stringify(ROUTE_PATH)}, (req: any, res: any) => {`,
    ...indentBy(site.bodyLines, "  "),
    "});",
    "",
    "export default router;",
    "",
  ].join("\n");

  return {
    files: { ...site.extraFiles, [ENV_ENTRY_FILE]: entry },
    reads: [{ name: spec.varName, defaulted: spec.form === "defaulted" }],
  };
}
