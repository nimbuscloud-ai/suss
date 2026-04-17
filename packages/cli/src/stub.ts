// stub.ts — `suss stub` command implementation
//
// Generates BehavioralSummary[] from a declared contract source rather than
// from TypeScript code. Each --from value maps to a tiny loader that knows
// how to turn a file path into summaries; future stub kinds (GraphQL SDL,
// gRPC proto, etc.) plug in the same way.

import fs from "node:fs";
import path from "node:path";

import type { BehavioralSummary } from "@suss/behavioral-ir";

export type StubSource = "openapi" | "cloudformation";

export interface StubOptions {
  from: StubSource;
  spec: string;
  output?: string;
}

type StubLoader = (specPath: string) => Promise<BehavioralSummary[]>;

const STUB_LOADERS: Record<StubSource, StubLoader> = {
  openapi: async (specPath) => {
    const mod = await import("@suss/stub-openapi");
    return mod.openApiFileToSummaries(specPath);
  },
  cloudformation: async (specPath) => {
    const mod = await import("@suss/stub-cloudformation");
    return mod.cloudFormationFileToSummaries(specPath);
  },
};

export async function stub(options: StubOptions): Promise<BehavioralSummary[]> {
  const loader = STUB_LOADERS[options.from];
  if (loader === undefined) {
    throw new Error(
      `Unknown stub source: "${options.from}". Supported: ${Object.keys(STUB_LOADERS).join(", ")}`,
    );
  }

  const summaries = await loader(options.spec);

  const json = JSON.stringify(summaries, null, 2);

  if (options.output !== undefined) {
    const outPath = path.resolve(options.output);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, `${json}\n`);
    process.stderr.write(
      `Wrote ${summaries.length} stub summaries to ${outPath}\n`,
    );
  } else {
    process.stdout.write(`${json}\n`);
  }

  return summaries;
}
