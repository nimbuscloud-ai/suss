// generate-schema.mjs
//
// Regenerates schema/behavioral-summary.schema.json from the zod schemas
// in src/schemas.ts. Run as `npm run schema:generate` (and as part of
// `npm run build` via the postbuild hook). The committed JSON Schema is
// the published, language-agnostic export — non-TS tools (Python, Go,
// other languages) can read summaries by validating against it without
// installing zod.

import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { BehavioralSummaryArraySchema } from "../dist/schemas.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outPath = resolve(__dirname, "../schema/behavioral-summary.schema.json");

const jsonSchema = z.toJSONSchema(BehavioralSummaryArraySchema, {
  target: "draft-2020-12",
});

const wrapped = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://suss.dev/schemas/behavioral-summary.schema.json",
  title: "BehavioralSummaryArray",
  description:
    "Array of behavioral summaries — see https://github.com/nimbuscloud-ai/suss/blob/main/docs/behavioral-summary-format.md",
  ...jsonSchema,
};

writeFileSync(outPath, `${JSON.stringify(wrapped, null, 2)}\n`, "utf8");
console.log(`wrote ${outPath}`);
