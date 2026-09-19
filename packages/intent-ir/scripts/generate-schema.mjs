// Regenerates schema/intent-doc.schema.json from the zod schemas in
// src/schema.ts. The committed file is how an editor checks an intent
// document, and how a tool outside TypeScript reads one.

import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { IntentDocSchema } from "../dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outPath = resolve(__dirname, "../schema/intent-doc.schema.json");

// The input side, so a field with a default stays optional the way it
// is for somebody writing the file by hand.
const jsonSchema = z.toJSONSchema(IntentDocSchema, {
  target: "draft-2020-12",
  io: "input",
});

const wrapped = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://suss.dev/schemas/intent-doc.schema.json",
  title: "IntentDoc",
  description:
    "One suss intent document, either boundary intent or a PRD, see https://github.com/nimbuscloud-ai/suss/blob/main/docs/reference/intent-format.md",
  ...jsonSchema,
};

writeFileSync(outPath, `${JSON.stringify(wrapped, null, 2)}\n`, "utf8");
console.log(`wrote ${outPath}`);
