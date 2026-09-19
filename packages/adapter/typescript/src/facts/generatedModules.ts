/**
 * A library's own module, written into the project by that library's
 * code generator.
 *
 * A pack says which file its generator leaves beside the module it
 * wrote, and a directory containing that file counts as the package.
 * The README says why the import gate needs this.
 */

import fs from "node:fs";
import path from "node:path";

export class GeneratedModules {
  private readonly generatedDirs = new Map<string, boolean>();

  constructor(private readonly markers: ReadonlyArray<string>) {}

  /** Whether any pack asked for a generated module to be looked for. */
  get declared(): boolean {
    return this.markers.length > 0;
  }

  /** Distinguishes two asks about one package that declare different markers. */
  get key(): string {
    return [...this.markers].sort().join(",");
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
      if (this.isGenerated(target) || this.isGenerated(path.dirname(target))) {
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
}

/** Every generated-module marker the given packs declare, deduplicated. */
export function collectGeneratedMarkers(
  packs: ReadonlyArray<{ generatedModuleMarkers?: string[] }>,
): string[] {
  const markers = new Set<string>();
  for (const pack of packs) {
    for (const marker of pack.generatedModuleMarkers ?? []) {
      markers.add(marker);
    }
  }
  return [...markers];
}
