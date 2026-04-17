// stub.ts — `suss stub` command implementation
//
// Generates BehavioralSummary[] from a declared contract source rather than
// from TypeScript code. Today only OpenAPI specs are supported; the --from
// flag picks the source kind so future stub sources (CDK synth, GraphQL SDL,
// gRPC proto) plug in the same way.

import fs from "node:fs";
import path from "node:path";

import type { BehavioralSummary } from "@suss/behavioral-ir";

export type StubSource = "openapi";

export interface StubOptions {
  from: StubSource;
  spec: string;
  output?: string;
}

const STUB_LOADERS: Record<
  StubSource,
  () => Promise<{
    openApiFileToSummaries: (file: string) => BehavioralSummary[];
  }>
> = {
  openapi: () => import("@suss/stub-openapi"),
};

export async function stub(options: StubOptions): Promise<BehavioralSummary[]> {
  const loader = STUB_LOADERS[options.from];
  if (loader === undefined) {
    throw new Error(
      `Unknown stub source: "${options.from}". Supported: ${Object.keys(STUB_LOADERS).join(", ")}`,
    );
  }

  const mod = await loader();
  const summaries = mod.openApiFileToSummaries(options.spec);

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
