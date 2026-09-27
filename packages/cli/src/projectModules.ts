/**
 * The module list in `suss.json`, checked and turned into absolute paths
 * for an adapter.
 *
 * A module export is keyed `fn:<module>::<export>`, the same key space a
 * workspace package's exports use, so a module named like one of the
 * workspace's packages would give two different things one key. The list
 * is refused when it loads rather than letting the two pair by accident.
 * A name is also refused when it could be read as a path, because the
 * binding keeps a module's name in the field a server action keeps its
 * file in, and only the separator tells them apart.
 */

import fs from "node:fs";
import path from "node:path";

import { PROJECT_FILE } from "./projectFile.js";
import { UsageError } from "./usageError.js";
import { readWorkspace } from "./workspaces.js";

import type { DeclaredModule } from "@suss/extractor";
import type { ModuleEntry } from "./projectFile.js";

const MODULE_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

/**
 * The modules the nearest `suss.json` at or above `start` lists, with
 * absolute paths. Empty when there is no such file or it lists none.
 */
export function projectModules(start: string): DeclaredModule[] {
  const file = nearestProjectFile(path.resolve(start));
  if (file === null) {
    return [];
  }
  const listed = modulesListedIn(file);
  if (listed.length === 0) {
    return [];
  }
  const dir = path.dirname(file);
  refuseBadNames(listed, packageNamesAt(dir), file);
  return listed.map((entry) => declaredModule(entry, dir));
}

function nearestProjectFile(start: string): string | null {
  let dir = start;
  for (;;) {
    const candidate = path.join(dir, PROJECT_FILE);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

/** A file that does not parse lists no modules, the way `readProjectFile` treats it. */
function modulesListedIn(file: string): ModuleEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return [];
  }
  const modules = (parsed as { modules?: unknown } | null)?.modules;
  if (modules === undefined) {
    return [];
  }
  if (!Array.isArray(modules) || !modules.every(isModuleEntry)) {
    throw new UsageError(
      `${file}: "modules" has to be a list of { "name", "root" } entries, each with an optional "public" file or list of files.`,
    );
  }
  return modules;
}

function isModuleEntry(value: unknown): value is ModuleEntry {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const entry = value as Record<string, unknown>;
  const publicFiles = entry.public;
  return (
    typeof entry.name === "string" &&
    typeof entry.root === "string" &&
    (publicFiles === undefined ||
      typeof publicFiles === "string" ||
      (Array.isArray(publicFiles) &&
        publicFiles.every((one) => typeof one === "string")))
  );
}

/** The workspace's package names, and the project's own, which share the `fn:` keys. */
function packageNamesAt(dir: string): Set<string> {
  const names = new Set<string>();
  for (const workspacePackage of readWorkspace(dir).packages) {
    if (workspacePackage.name !== null) {
      names.add(workspacePackage.name);
    }
  }
  try {
    const own = JSON.parse(
      fs.readFileSync(path.join(dir, "package.json"), "utf8"),
    ) as { name?: unknown };
    if (typeof own.name === "string") {
      names.add(own.name);
    }
  } catch {
    // A project with no package.json has no package to collide with.
  }
  return names;
}

function refuseBadNames(
  modules: readonly ModuleEntry[],
  packageNames: ReadonlySet<string>,
  file: string,
): void {
  const seen = new Set<string>();
  for (const { name } of modules) {
    if (!MODULE_NAME.test(name)) {
      throw new UsageError(
        `${file}: the module name "${name}" can only use letters, digits, "_", "-" and ".". It is the name every key for the module's exports starts with, so it cannot look like a path.`,
      );
    }
    if (seen.has(name)) {
      throw new UsageError(
        `${file}: two modules are called "${name}". Each module needs its own name, since its exports are keyed by it.`,
      );
    }
    if (packageNames.has(name)) {
      throw new UsageError(
        `${file}: the module "${name}" has the same name as a package in this workspace, and both would key their exports as fn:${name}::<export>. Rename the module.`,
      );
    }
    seen.add(name);
  }
}

function declaredModule(entry: ModuleEntry, dir: string): DeclaredModule {
  const publicFiles =
    entry.public === undefined
      ? undefined
      : (typeof entry.public === "string" ? [entry.public] : entry.public).map(
          (file) => path.resolve(dir, file),
        );
  return {
    name: entry.name,
    root: path.resolve(dir, entry.root),
    ...(publicFiles === undefined ? {} : { public: publicFiles }),
  };
}
