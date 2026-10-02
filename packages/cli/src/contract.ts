/**
 * `suss contract`: summaries from a declared artifact such as an OpenAPI
 * document or a Terraform module, in place of source code.
 *
 * Each `--from` value has a loader in the table below that turns a path
 * into summaries. The loaders import their contract package on demand, so
 * a run pays only for the reader it uses. A new contract source is one
 * more entry in the table.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { writeJson } from "./jsonStream.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

export type ContractSource =
  | "openapi"
  | "cloudformation"
  | "terraform"
  | "serverless"
  | "storybook"
  | "appsync"
  | "prisma"
  | "graphql"
  | "graphql-documents"
  | "wrangler";

export interface ContractOptions {
  from: ContractSource;
  spec: string;
  output?: string;
  /**
   * The directory each deployable unit's code is in, keyed by instance
   * name. A Terraform configuration never says which directory a
   * container's image was built from, so without this `check` cannot pair
   * the unit with its code.
   */
  codeScopes?: Record<string, string>;
}

export interface ContractReadOptions extends Omit<ContractOptions, "output"> {
  /**
   * Collects what a reader would otherwise print on stderr, such as a
   * `$ref` it could not follow. Readers that print nothing ignore it.
   */
  warnings?: string[];
}

/**
 * `source` is the label recorded on every summary, and the CLI sets it
 * only for a spec fetched from a URL. For a file on disk the reader labels
 * summaries by the file's place in the repository. Only the reader can do
 * that, because it is the reader that turns a directory into a file.
 */
type ContractLoader = (
  specPath: string,
  source: string | undefined,
  options: ContractReadOptions,
) => Promise<BehavioralSummary[]>;

const CONTRACT_LOADERS: Record<ContractSource, ContractLoader> = {
  openapi: async (specPath, _source, options) => {
    const mod = await import("@suss/contract-openapi");
    return mod.openApiFileToSummaries(specPath, warningsOf(options));
  },
  cloudformation: async (specPath, source, options) => {
    const mod = await import("@suss/contract-cloudformation");
    return mod.cloudFormationFileToSummaries(specPath, {
      ...(source !== undefined ? { source } : {}),
      ...warningsOf(options),
    });
  },
  terraform: async (specPath, _source, options) => {
    // The path may be a module's directory, because a module usually
    // spreads its resources across several `.tf` files. A new provider
    // pack gets loaded here beside these two.
    const [reader, aws, gcp] = await Promise.all([
      import("@suss/contract-terraform"),
      import("@suss/terraform-aws"),
      import("@suss/terraform-gcp"),
    ]);
    return reader.terraformFileToSummaries(specPath, {
      packs: [aws.awsTerraform(), gcp.googleTerraform()],
      ...(options.codeScopes !== undefined
        ? { codeScopes: options.codeScopes }
        : {}),
    });
  },
  serverless: async (specPath, source, options) => {
    const mod = await import("@suss/contract-serverless");
    const { warnings } = options;
    return mod.serverlessFileToSummaries(specPath, {
      ...(source !== undefined ? { source } : {}),
      ...(warnings !== undefined
        ? { onUnread: (wiring) => warnings.push(unreadWiringLine(wiring)) }
        : {}),
    });
  },
  storybook: async (specPath) => {
    const mod = await import("@suss/contract-storybook");
    const files = expandStoryPaths(specPath);
    return mod.generateSummariesFromStories(files);
  },
  appsync: async (specPath) => {
    const mod = await import("@suss/contract-appsync");
    return mod.appsyncFileToSummaries(specPath);
  },
  prisma: async (specPath) => {
    const mod = await import("@suss/contract-prisma");
    return mod.prismaSchemaFileToSummaries(specPath);
  },
  graphql: async (specPath) => {
    const mod = await import("@suss/contract-graphql");
    return mod.graphqlSdlFileToSummaries(specPath);
  },
  wrangler: async (specPath, source) => {
    const mod = await import("@suss/contract-wrangler");
    return mod.wranglerFileToSummaries(specPath, {
      ...(source !== undefined ? { source } : {}),
    });
  },
  "graphql-documents": async (specPath) => {
    const mod = await import("@suss/contract-graphql");
    return mod.graphqlDocumentsPathToSummaries(specPath);
  },
};

/**
 * Readers that can say whether a path has anything to read without
 * reading all of it. Reading every story in a large app under its
 * tsconfig takes seconds per folder, and `init` only needs to know
 * whether a `contract` command there would read anything.
 */
const SAMPLE_LOADERS: Partial<Record<ContractSource, ContractLoader>> = {
  storybook: async (specPath) => {
    const mod = await import("@suss/contract-storybook");
    return firstBatchWithSummaries(expandStoryPaths(specPath), (files) =>
      mod.generateSummariesFromStories(files, { componentModules: false }),
    );
  },
};

/**
 * The summaries of the first batch of files that gives any. The batches
 * double in size, so a folder whose first file reads costs one file, and
 * a folder where nothing reads costs about one read of every file.
 */
export function firstBatchWithSummaries(
  files: ReadonlyArray<string>,
  read: (batch: string[]) => BehavioralSummary[],
): BehavioralSummary[] {
  let start = 0;
  for (let size = 1; start < files.length; size *= 2) {
    const summaries = read(files.slice(start, start + size));
    if (summaries.length > 0) {
      return summaries;
    }

    start += size;
  }
  return [];
}

function warningsOf(options: ContractReadOptions): { warnings?: string[] } {
  return options.warnings === undefined ? {} : { warnings: options.warnings };
}

function unreadWiringLine(wiring: {
  functionName: string | null;
  kind: string;
  reason: string;
}): string {
  const where =
    wiring.functionName === null
      ? wiring.kind
      : `${wiring.functionName}.${wiring.kind}`;
  return `${where}: ${wiring.reason}`;
}

function expandStoryPaths(spec: string): string[] {
  const absolute = path.resolve(spec);
  if (fs.existsSync(absolute)) {
    const stat = fs.statSync(absolute);
    if (stat.isFile()) {
      return [absolute];
    }
    if (stat.isDirectory()) {
      return walkForStoryFiles(absolute);
    }
  }
  // The shell expands a glob before the CLI sees it, so a path that does
  // not exist here is a mistake in the path itself.
  throw new Error(
    `No stories found at "${spec}". Pass a .stories.ts[x] file or a directory containing them.`,
  );
}

function walkForStoryFiles(dir: string): string[] {
  const out: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isFile()) {
      if (/\.stories\.tsx?$/.test(entry.name)) {
        out.push(full);
      }
    } else if (entry.isDirectory()) {
      out.push(...walkForStoryFiles(full));
    }
  }
  return out;
}

/**
 * Fetches a spec given as an http(s) URL into a temp file, so the loaders
 * only ever read files. The caller runs `cleanup` once the loader is done.
 * Any other spec comes back unchanged.
 *
 * The temp file keeps the URL's extension because loaders pick a JSON or
 * YAML parser by extension. With no extension it gets `.yaml`, since
 * OpenAPI and CloudFormation documents on the web are most often YAML.
 */
async function resolveSpec(
  spec: string,
): Promise<{ path: string; fetchedFrom?: string; cleanup?: () => void }> {
  if (!/^https?:\/\//i.test(spec)) {
    return { path: spec };
  }
  const response = await fetch(spec);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch contract from ${spec}: ${response.status} ${response.statusText}`,
    );
  }
  const content = await response.text();
  const urlPath = new URL(spec).pathname;
  const ext = path.extname(urlPath) || ".yaml";
  const tmpPath = path.join(os.tmpdir(), `suss-contract-${randomUUID()}${ext}`);
  fs.writeFileSync(tmpPath, content);
  return {
    path: tmpPath,
    fetchedFrom: spec,
    cleanup: () => {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // A temp file left behind does no harm, so a failed delete is ignored.
      }
    },
  };
}

export async function contract(
  options: ContractOptions,
): Promise<BehavioralSummary[]> {
  const summaries = await readContract(options);

  if (options.output !== undefined) {
    const outPath = path.resolve(options.output);
    await writeJson({ value: summaries, indent: 2, file: outPath });
    process.stderr.write(
      summaries.length === 0
        ? `${options.spec} declares no boundaries suss could read.\n`
        : `Wrote ${summaries.length} summar${summaries.length === 1 ? "y" : "ies"} to ${outPath}\n`,
    );
  } else {
    await writeJson({ value: summaries, indent: 2 });
  }

  return summaries;
}

/** The summaries the reader for `options.from` gives, without writing them anywhere. */
export async function readContract(
  options: ContractReadOptions,
): Promise<BehavioralSummary[]> {
  const loader = CONTRACT_LOADERS[options.from];
  if (loader === undefined) {
    throw new Error(
      `Unknown contract source: "${options.from}". Supported: ${Object.keys(CONTRACT_LOADERS).join(", ")}`,
    );
  }

  return readWith(loader, options);
}

export interface ContractSample {
  summaries: BehavioralSummary[];
  /** True when these are every summary a `contract` run would write. */
  whole: boolean;
}

/**
 * Enough of what the reader for `options.from` gives to say whether it
 * reads anything there. Most readers read the whole file anyway.
 */
export async function sampleContract(
  options: ContractReadOptions,
): Promise<ContractSample> {
  const sample = SAMPLE_LOADERS[options.from];
  if (sample === undefined) {
    return { summaries: await readContract(options), whole: true };
  }

  return { summaries: await readWith(sample, options), whole: false };
}

async function readWith(
  loader: ContractLoader,
  options: ContractReadOptions,
): Promise<BehavioralSummary[]> {
  const resolved = await resolveSpec(options.spec);
  // The temp file's name is random, so a fetched spec is labelled by its
  // URL instead.
  const source =
    resolved.fetchedFrom === undefined
      ? undefined
      : `${options.from}:${resolved.fetchedFrom}`;
  let summaries: BehavioralSummary[];
  try {
    summaries = await loader(resolved.path, source, options);
  } finally {
    resolved.cleanup?.();
  }
  return summaries;
}
