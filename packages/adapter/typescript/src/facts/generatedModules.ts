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

import type { PatternPack } from "@suss/extractor";

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
   * generator wrote. A specifier can name the directory itself or a
   * file in it, so both are checked.
   */
  reachedFrom(fromFile: string, specifiers: ReadonlyArray<string>): boolean {
    if (!this.declared) {
      return false;
    }
    const fromDir = path.dirname(fromFile);
    for (const specifier of specifiers) {
      if (!specifier.startsWith(".")) {
        continue;
      }
      const target = path.resolve(fromDir, specifier);
      if (
        this.isGenerated(target) ||
        this.isGenerated(path.dirname(target)) ||
        this.isDeclaredOutput(fromDir, target)
      ) {
        return true;
      }
    }
    return false;
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

/** What the given packs say about the modules their generators write. */
export function generatedModulesOf(
  packs: ReadonlyArray<GeneratingPack>,
): GeneratedModules {
  const markers = new Set<string>();
  const finders: Array<{ pack: string; find: DirFinder }> = [];
  for (const pack of packs) {
    for (const marker of pack.generatedModuleMarkers ?? []) {
      markers.add(marker);
    }
    if (pack.generatedModuleDirs !== undefined) {
      finders.push({ pack: pack.name, find: pack.generatedModuleDirs });
    }
  }
  return new GeneratedModules([...markers], finders);
}
