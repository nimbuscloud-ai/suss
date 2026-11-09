/**
 * A library's own module, written into the project by that library's
 * code generator.
 *
 * A pack says which file its generator leaves beside the module it
 * wrote, and a directory containing that file counts as the package. A
 * pack whose generator leaves no such file says instead where the
 * project's configuration tells the generator to write. The README says
 * why the import gate needs this.
 */

import fs from "node:fs";
import path from "node:path";

import { runPackHook } from "@suss/extractor";

import { specifierTargets } from "./specifierTargets.js";

import type { PackTally, PatternPack } from "@suss/extractor";
import type { ts } from "ts-morph";

type DirFinder = NonNullable<PatternPack["generatedModuleDirs"]>;

type GeneratingPack = Pick<
  PatternPack,
  "name" | "generatedModuleMarkers" | "generatedModuleDirs"
>;

export class GeneratedModules {
  private readonly generatedDirs = new Map<string, boolean>();

  private readonly declaredDirs = new Map<string, readonly string[]>();

  constructor(
    private readonly markers: ReadonlyArray<string>,
    private readonly finders: ReadonlyArray<{
      pack: string;
      find: DirFinder;
    }> = [],
    private readonly compilerOptions: ts.CompilerOptions = {},
  ) {}

  /** Whether any pack asked for a generated module to be looked for. */
  get declared(): boolean {
    return this.markers.length > 0 || this.finders.length > 0;
  }

  /** Distinguishes two asks about one package that declare different markers. */
  get key(): string {
    return [
      [...this.markers].sort().join(","),
      ...this.finders.map((finder) => finder.pack).sort(),
    ].join("|");
  }

  /**
   * Whether any of this file's specifiers points into a directory the
   * generator wrote. A specifier can point at the directory itself or at
   * a file in it, so both are checked. A bare specifier counts through
   * the project's `baseUrl` and `paths`.
   */
  reachedFrom(fromFile: string, specifiers: ReadonlyArray<string>): boolean {
    if (!this.declared) {
      return false;
    }
    const fromDir = path.dirname(fromFile);
    for (const specifier of specifiers) {
      // A package such as `prisma/config` also maps under `baseUrl`, into
      // the project's own schema folder, which contains the marker too. So
      // for a bare specifier only the project's configuration is evidence.
      const markerCounts = specifier.startsWith(".");
      const targets = specifierTargets(
        fromFile,
        specifier,
        this.compilerOptions,
      );
      if (
        targets.some(
          (target) =>
            (markerCounts && this.containsMarker(target)) ||
            this.isDeclaredOutput(fromDir, target),
        )
      ) {
        return true;
      }
    }
    return false;
  }

  private containsMarker(target: string): boolean {
    return this.isGenerated(target) || this.isGenerated(path.dirname(target));
  }

  private isGenerated(dir: string): boolean {
    const known = this.generatedDirs.get(dir);
    if (known !== undefined) {
      return known;
    }
    const found = this.markers.some((marker) =>
      fs.existsSync(path.join(dir, marker)),
    );
    this.generatedDirs.set(dir, found);
    return found;
  }

  private isDeclaredOutput(fromDir: string, target: string): boolean {
    if (this.finders.length === 0) {
      return false;
    }
    let dirs = this.declaredDirs.get(fromDir);
    if (dirs === undefined) {
      dirs = this.finders.flatMap((finder) => finder.find(fromDir));
      this.declaredDirs.set(fromDir, dirs);
    }
    return dirs.some(
      (dir) => target === dir || target.startsWith(`${dir}${path.sep}`),
    );
  }
}

/**
 * What the given packs say about the modules their generators write. A
 * pack's `generatedModuleDirs` that throws gives no directory for the
 * file it was asked about, and the failure goes on the pack's tally. The
 * compiler options say where a bare specifier points.
 */
export function generatedModulesOf(
  packs: ReadonlyArray<GeneratingPack>,
  tallies?: ReadonlyMap<string, PackTally>,
  compilerOptions: ts.CompilerOptions = {},
): GeneratedModules {
  const markers = new Set<string>();
  const finders: Array<{ pack: string; find: DirFinder }> = [];
  for (const pack of packs) {
    for (const marker of pack.generatedModuleMarkers ?? []) {
      markers.add(marker);
    }
    const find = pack.generatedModuleDirs;
    if (find !== undefined) {
      finders.push({
        pack: pack.name,
        find: (fromDir) =>
          runPackHook(
            tallies?.get(pack.name),
            { pack: pack.name, hook: "generatedModuleDirs", file: fromDir },
            () => find(fromDir),
            [],
          ),
      });
    }
  }
  return new GeneratedModules([...markers], finders, compilerOptions);
}
