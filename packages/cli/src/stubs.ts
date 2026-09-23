/**
 * Dependency stubs: checked-in files in `suss/stubs/` that describe a
 * package the project's own code cannot describe, such as a wrapper that
 * composes a framework decorator.
 *
 * The CLI turns each statement into an entry in the pack option that
 * already reads the same fact, before the pack factories run. Packs and
 * adapters never see a stub. Because the merged options go into the same
 * digest as pack config, editing a stub invalidates the extraction cache
 * the same way editing config does. Stubs may be YAML or JSON, with one
 * schema for both.
 */

import fs from "node:fs";
import path from "node:path";

import { parse as parseYaml } from "yaml";
import { z } from "zod";

import { GRAPHQL_RUBY_ROOT_CLASS_NAMES } from "@suss/packs/graphql-ruby";
import { RAILS_ROOT_CLASS_NAMES } from "@suss/packs/rails";

import { UsageError } from "./usageError.js";

const StatementSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("composes-decorator"),
    export: z.string(),
    composes: z.object({ module: z.string(), name: z.string() }),
  }),
  z.object({
    kind: z.literal("extends-base"),
    /** A class the package defines, which project classes use as their superclass. */
    class: z.string(),
    /** The framework root class that `class` descends from. It picks the pack. */
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
  /** Who wrote the stub, so a reader can judge how far to trust it. */
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
 * A stub describes the package version its author read, and the project
 * may since have upgraded. When the version in `from:` differs from the
 * installed one, this returns a line asking the user to recheck the stub.
 * Returns null when `from` has no version, the package is not installed
 * under the project root, or the versions match.
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
 * The packs that read a composed decorator, keyed by the framework
 * decorator it composes. The table is in the CLI because the CLI is where
 * packs get assembled, the same place `-f` names map to packages.
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

const GRAPHQL_RUBY_ROOTS = new Set(GRAPHQL_RUBY_ROOT_CLASS_NAMES);
const RAILS_ROOTS = new Set(RAILS_ROOT_CLASS_NAMES);

/**
 * The Ruby packs that get a stub's base class, chosen by the root class
 * the stub says it descends from. When the root is in neither pack's
 * list, both packs get the class. The pack whose framework the class does
 * not descend from never matches it, so the extra entry is harmless.
 */
function rubyPacksExtending(rootClassName: string): string[] {
  if (GRAPHQL_RUBY_ROOTS.has(rootClassName)) {
    return ["graphql-ruby"];
  }

  if (RAILS_ROOTS.has(rootClassName)) {
    return ["rails"];
  }

  return ["graphql-ruby", "rails"];
}

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
    for (const pack of rubyPacksExtending(statement.extends)) {
      append(overlay, pack, "baseClassNames", statement.class);
    }
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
 * Option keys, per pack, that only a dependency stub may set. The stub
 * overlay writes these keys and pack factories still read them. The CLI
 * refuses them only in a project's own config file.
 *
 * An option that suss now reads from the code instead is refused through
 * the retired-options table.
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
  rails: ["baseClassNames"],
};

export function stubOnlyOptionsOf(packName: string): readonly string[] {
  return STUB_ONLY_OPTIONS[packName] ?? [];
}

/** The reverse of `RE_EXPORT_CONSUMERS`, for the example in a refusal message. */
const WRAPPER_MODULE_REEXPORTS: Record<string, string> = {
  fastapi: "fastapi",
  "flask-restx": "flask_restx",
};

/**
 * wrapperModules matches a project module by its exact name, so each
 * wrapper module the project imports from needs its own stub. The refusal
 * prints an example stub, because the general stub docs do not show that.
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

/** The error message for a project config that sets a stub-only option. */
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
 * A pack's options with the stub overlay's items appended under each key.
 * The options from config come first, so entries a project set by hand
 * are kept.
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
