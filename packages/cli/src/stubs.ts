/**
 * Dependency stubs: checked-in declarations about packages the repo's
 * code cannot state, read from `suss/stubs/` at the project root.
 *
 * v1 is a projection, per design/proposals/dependency-stubs.md: each
 * statement routes into the pack option that consumes the same fact
 * today, before the pack factories run, so no pack or adapter
 * changes. The merged options flow through the same digest pack
 * config does, so an edited stub invalidates the extraction cache the
 * same way. YAML and JSON both parse, one schema.
 */

import fs from "node:fs";
import path from "node:path";

import { parse as parseYaml } from "yaml";
import { z } from "zod";

import { UsageError } from "./usageError.js";

const StatementSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("composes-decorator"),
    export: z.string(),
    composes: z.object({ module: z.string(), name: z.string() }),
  }),
  z.object({
    kind: z.literal("extends-base"),
    class: z.string(),
    extends: z.string(),
  }),
  z.object({
    kind: z.literal("re-exports"),
    of: z.string(),
  }),
  z.object({
    kind: z.literal("performs-call"),
    export: z.string().optional(),
    system: z.string(),
    spec: z.record(z.string(), z.unknown()),
  }),
]);

const StubFileSchema = z.object({
  package: z.string(),
  /** Who wrote it and from what, for a reader weighing the claims. */
  authored: z.string().optional(),
  from: z.string().optional(),
  statements: z.array(StatementSchema).min(1),
});

export type StubStatement = z.infer<typeof StatementSchema>;
export type StubFile = z.infer<typeof StubFileSchema>;

/** Pack name to option key to items appended under it. */
export type StubOverlay = Map<string, Map<string, unknown[]>>;

const STUB_DIR = path.join("suss", "stubs");
const STUB_EXTENSIONS = new Set([".yaml", ".yml", ".json"]);

export function loadStubs(root: string): StubFile[] {
  const dir = path.join(root, STUB_DIR);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }

  const files: StubFile[] = [];
  for (const entry of entries.sort()) {
    if (!STUB_EXTENSIONS.has(path.extname(entry))) {
      continue;
    }
    const filePath = path.join(dir, entry);
    const text = fs.readFileSync(filePath, "utf8");
    const value =
      path.extname(entry) === ".json" ? JSON.parse(text) : parseYaml(text);
    const parsed = StubFileSchema.safeParse(value);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw new UsageError(
        `${filePath} is not a stub suss can read: ${first.path.join(".")} ${first.message}`,
      );
    }
    files.push(parsed.data);

    const drift = driftNote(root, parsed.data);
    if (drift !== null) {
      process.stderr.write(drift);
    }
  }
  return files;
}

/**
 * A stub keeps describing the version its author read while the
 * project moves to newer ones, so a mismatch between the version in
 * `from:` and the installed package is worth a line. Null when `from`
 * has no version in it, the package is not installed where the loader
 * can see it, or the two agree.
 */
function driftNote(root: string, stub: StubFile): string | null {
  const fromVersion = stub.from?.match(/\d+\.\d+\.\d+[-+.\w]*/)?.[0];
  if (fromVersion === undefined) {
    return null;
  }

  const installed = installedVersionOf(root, stub.package);
  if (installed === null || installed === fromVersion) {
    return null;
  }

  return (
    `[suss] ${stub.package} is installed at ${installed}, and its stub was written from ${fromVersion}. ` +
    `Check the stub's claims against the installed version, then update its from: line.\n`
  );
}

function installedVersionOf(root: string, packageName: string): string | null {
  const manifest = path.join(root, "node_modules", packageName, "package.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(manifest, "utf8")) as {
      version?: unknown;
    };
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

function append(
  overlay: StubOverlay,
  pack: string,
  option: string,
  item: unknown,
): void {
  const byOption = overlay.get(pack) ?? new Map<string, unknown[]>();
  const items = byOption.get(option) ?? [];
  items.push(item);
  byOption.set(option, items);
  overlay.set(pack, byOption);
}

/**
 * Which packs consume a composed decorator, by the decorator it
 * composes. The table is CLI assembly knowledge, the same layer that
 * already maps `-f` names to packages.
 */
const DECORATOR_CONSUMERS: Record<string, string[]> = {
  "@nestjs/common Controller": ["nestjs-rest", "nestjs-microservices"],
  "@nestjs/graphql Resolver": ["nestjs-graphql"],
};

const CALL_CONSUMERS: Record<string, { pack: string; option: string }> = {
  "aws.sqs": { pack: "aws-sqs", option: "producers" },
  "aws.events": { pack: "aws-eventbridge", option: "producers" },
  axios: { pack: "axios", option: "factories" },
};

const RE_EXPORT_CONSUMERS: Record<string, string> = {
  fastapi: "fastapi",
  flask_restx: "flask-restx",
};

export function stubOverlayOf(stubs: StubFile[]): StubOverlay {
  const overlay: StubOverlay = new Map();
  for (const stub of stubs) {
    for (const statement of stub.statements) {
      routeStatement(overlay, stub, statement);
    }
  }
  return overlay;
}

function routeStatement(
  overlay: StubOverlay,
  stub: StubFile,
  statement: StubStatement,
): void {
  if (statement.kind === "composes-decorator") {
    const key = `${statement.composes.module} ${statement.composes.name}`;
    for (const pack of DECORATOR_CONSUMERS[key] ?? []) {
      append(overlay, pack, "classDecorators", statement.export);
    }
    return;
  }

  if (statement.kind === "extends-base") {
    append(overlay, "graphql-ruby", "baseClassNames", statement.extends);
    return;
  }

  if (statement.kind === "re-exports") {
    const pack = RE_EXPORT_CONSUMERS[statement.of];
    if (pack !== undefined) {
      append(overlay, pack, "wrapperModules", stub.package);
    }
    return;
  }

  const consumer = CALL_CONSUMERS[statement.system];
  if (consumer !== undefined) {
    append(overlay, consumer.pack, consumer.option, {
      module: stub.package,
      ...(statement.export !== undefined ? { export: statement.export } : {}),
      ...statement.spec,
    });
  }
}

/**
 * Option keys only a dependency stub may state, per pack. The overlay
 * above writes these same keys, so a pack factory still reads them;
 * what the CLI refuses is a project's own config file setting one.
 *
 * An option that went because suss reads the same fact off the code is
 * refused through the retired table instead.
 */
const STUB_ONLY_OPTIONS: Record<string, readonly string[]> = {
  "nestjs-rest": ["classDecorators"],
  "nestjs-microservices": ["classDecorators"],
  "nestjs-graphql": ["classDecorators"],
  "aws-sqs": ["producers"],
  "aws-eventbridge": ["producers"],
  axios: ["factories"],
  fastapi: ["wrapperModules"],
  "flask-restx": ["wrapperModules"],
  "graphql-ruby": ["baseClassNames"],
};

export function stubOnlyOptionsOf(packName: string): readonly string[] {
  return STUB_ONLY_OPTIONS[packName] ?? [];
}

/** The reverse of `RE_EXPORT_CONSUMERS`: which `of:` value a wrapperModules pack's own re-exports statement takes. */
const WRAPPER_MODULE_REEXPORTS: Record<string, string> = {
  fastapi: "fastapi",
  "flask-restx": "flask_restx",
};

/**
 * wrapperModules matches a project module exactly, one stub per
 * module the project imports, so the refusal shows the shape rather
 * than pointing at the general stub docs alone.
 */
function wrapperModulesExample(packName: string): string {
  const reExports = WRAPPER_MODULE_REEXPORTS[packName];
  if (reExports === undefined) {
    return "";
  }
  return (
    "\n\n  package: myapp.routing.namespace\n" +
    "  statements:\n" +
    "    - kind: re-exports\n" +
    `      of: ${reExports}\n\n` +
    "package is the full module the project imports from, one stub per imported module."
  );
}

/** What a project reads when its pack config sets one of them. */
export function stubOnlyOptionRefusal(
  used: readonly string[],
  packName: string,
): string {
  const plural = used.length > 1;
  const base =
    `The ${used.join(" and ")} option${plural ? "s" : ""} ` +
    `describe${plural ? "" : "s"} a dependency, and a stub file in suss/stubs/ is where that now goes. ` +
    "Start one with: suss infer stub <package>.";
  return used.includes("wrapperModules")
    ? base + wrapperModulesExample(packName)
    : base;
}

/**
 * The options a pack factory gets, with the overlay's items appended
 * under each routed key. The stated options come first, so a project
 * that configures the same option by hand keeps its entries.
 */
export function withStubOptions(
  packName: string,
  options: unknown,
  overlay: StubOverlay | undefined,
): unknown {
  const byOption = overlay?.get(packName);
  if (byOption === undefined || byOption.size === 0) {
    return options;
  }
  const base =
    options !== null && typeof options === "object" && !Array.isArray(options)
      ? { ...(options as Record<string, unknown>) }
      : {};
  for (const [option, items] of byOption) {
    const existing = base[option];
    base[option] = Array.isArray(existing) ? [...existing, ...items] : items;
  }
  return base;
}
