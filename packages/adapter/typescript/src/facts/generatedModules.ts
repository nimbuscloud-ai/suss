/**
 * A library's own module, written into the project by that library's
 * code generator, which counts as the library.
 *
 * A pack says which package the generated module is a copy of, and how
 * to find the directories its generator writes: a file the generator
 * leaves beside the module, or where the project's configuration tells
 * the generator to write. An import into one of those directories counts
 * as an import of the package, for the import gate and in the `imports`
 * facts, and a file in one counts as declared by the package. The README
 * says why the import gate needs this.
 */

import fs from "node:fs";
import path from "node:path";

import { runPackHook } from "@suss/extractor";

import { specifierTargets } from "./specifierTargets.js";

import type {
  GeneratedModuleSpec,
  PackTally,
  PatternPack,
} from "@suss/extractor";
import type { ts } from "ts-morph";

type DirFinder = NonNullable<GeneratedModuleSpec["dirs"]>;

type GeneratingPack = Pick<PatternPack, "name" | "generatedModules">;

/** One pack's generator, with what it has found so far. */
class Generator {
  private readonly marked = new Map<string, boolean>();

  private readonly outputs = new Map<string, readonly string[]>();

  constructor(
    readonly pack: string,
    readonly of: string,
    private readonly markers: readonly string[],
    private readonly dirs: DirFinder | null,
  ) {}

  /**
   * Whether this generator writes the target, which an importing file in
   * `fromDir` points at. A package such as `prisma/config` also maps under
   * `baseUrl`, into the project's own schema folder, which contains the
   * marker too. So for a bare specifier only the configuration counts.
   */
  writes(fromDir: string, target: string, relative: boolean): boolean {
    return (
      (relative &&
        (this.isMarked(target) || this.isMarked(path.dirname(target)))) ||
      this.isOutput(fromDir, target)
    );
  }

  /** Whether a file is in a directory this generator wrote. */
  wrote(filePath: string): boolean {
    const dir = path.dirname(filePath);
    return this.isMarked(dir) || this.isOutput(dir, filePath);
  }

  private isMarked(dir: string): boolean {
    const known = this.marked.get(dir);
    if (known !== undefined) {
      return known;
    }
    const found = this.markers.some((marker) =>
      fs.existsSync(path.join(dir, marker)),
    );
    this.marked.set(dir, found);
    return found;
  }

  private isOutput(fromDir: string, target: string): boolean {
    if (this.dirs === null) {
      return false;
    }
    let dirs = this.outputs.get(fromDir);
    if (dirs === undefined) {
      dirs = this.dirs(fromDir);
      this.outputs.set(fromDir, dirs);
    }
    return dirs.some(
      (dir) => target === dir || target.startsWith(`${dir}${path.sep}`),
    );
  }
}

export class GeneratedModules {
  constructor(private readonly generators: readonly Generator[] = []) {}

  /** Whether any pack asked for a generated module to be looked for. */
  get declared(): boolean {
    return this.generators.length > 0;
  }

  /** Distinguishes two asks about one package from packs that generate differently. */
  get key(): string {
    return this.generators
      .map((generator) => generator.pack)
      .sort()
      .join(",");
  }

  /**
   * Whether any of this file's specifiers points into a directory a
   * generator wrote. A specifier can point at the directory itself or at
   * a file in it, and a bare one points there through the project's
   * `baseUrl` and `paths`.
   */
  reachedFrom(
    fromFile: string,
    specifiers: ReadonlyArray<string>,
    options: ts.CompilerOptions,
  ): boolean {
    if (!this.declared) {
      return false;
    }
    return specifiers.some(
      (specifier) => this.packagesAt(fromFile, specifier, options).length > 0,
    );
  }

  /** The packages whose generated module this specifier points into. */
  packagesAt(
    fromFile: string,
    specifier: string,
    options: ts.CompilerOptions,
  ): string[] {
    if (!this.declared) {
      return [];
    }
    const fromDir = path.dirname(fromFile);
    const relative = specifier.startsWith(".");
    const targets = specifierTargets(fromFile, specifier, options);
    return this.generators
      .filter((generator) =>
        targets.some((target) => generator.writes(fromDir, target, relative)),
      )
      .map((generator) => generator.of);
  }

  /** Whether this file is part of a module the package's generator wrote. */
  wroteFor(filePath: string, module: string): boolean {
    return this.generators.some(
      (generator) => generator.of === module && generator.wrote(filePath),
    );
  }
}

export const NO_GENERATOR = new GeneratedModules();

/**
 * Whether the package declared what this file declares: the file is in
 * the package's folder under `node_modules`, in the folder DefinitelyTyped
 * publishes its types to, or in a directory its generator wrote into the
 * project. A package that ships no types of its own, such as
 * `aws-lambda`, is described by `@types/aws-lambda`.
 */
export function declaredByPackage(
  filePath: string,
  module: string,
  generated: GeneratedModules = NO_GENERATOR,
): boolean {
  return (
    filePath.includes(`/node_modules/${module}/`) ||
    filePath.includes(`/node_modules/${typesPackageOf(module)}/`) ||
    generated.wroteFor(filePath, module)
  );
}

/** Where DefinitelyTyped publishes a module's types: `@types/foo` for `foo`, `@types/scope__name` for `@scope/name`. */
function typesPackageOf(module: string): string {
  return module.startsWith("@")
    ? `@types/${module.slice(1).replace("/", "__")}`
    : `@types/${module}`;
}

/**
 * What the given packs say about the modules their generators write. A
 * pack's `dirs` hook that throws gives no directory for the file it was
 * asked about, and the failure goes on the pack's tally.
 */
export function generatedModulesOf(
  packs: ReadonlyArray<GeneratingPack>,
  tallies?: ReadonlyMap<string, PackTally>,
): GeneratedModules {
  const generators: Generator[] = [];
  for (const { name, generatedModules: spec } of packs) {
    if (spec === undefined) {
      continue;
    }
    const markers = spec.markers ?? [];
    const find = spec.dirs;
    if (markers.length === 0 && find === undefined) {
      continue;
    }
    const dirs: DirFinder | null =
      find === undefined
        ? null
        : (fromDir) =>
            runPackHook(
              tallies?.get(name),
              { pack: name, hook: "generatedModules.dirs", file: fromDir },
              () => find(fromDir),
              [],
            );
    generators.push(new Generator(name, spec.of, markers, dirs));
  }
  return new GeneratedModules(generators);
}
