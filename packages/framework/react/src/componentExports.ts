// componentExports.ts — React's named-component-export discovery.
//
// React doesn't have its own DiscoveryMatch variant; it ships this
// callback for the `discoverUnits` hook. The pack-author conventions
// live HERE, not in the extractor — PascalCase naming, JSX-return
// detection, story-file exclusion. New frontend frameworks (Vue,
// Solid) own their conventions the same way.

import type {
  FunctionRoot,
  TsDiscoveryContext,
} from "@suss/adapter-typescript";
import type { DiscoveredCustomUnit, PatternPack } from "@suss/extractor";
import type { SourceFile } from "ts-morph";

const STORY_FILE_PATTERN = /\.stories\.tsx?$/;
const TEST_FILE_PATTERN = /\.(test|spec)\.tsx?$/;

function startsWithUppercase(name: string): boolean {
  if (name.length === 0) {
    return false;
  }
  const first = name[0];
  return first >= "A" && first <= "Z";
}

/**
 * Pack-supplied discovery callback for React function components.
 *
 * Matches every export (default OR named) whose declaration is a
 * function whose body has a JSX-returning statement, after applying
 * three React conventions:
 *
 * 1. Skip files matching `.stories.tsx?` / `.test.tsx?` / `.spec.tsx?`
 *    — those export functions returning JSX too, but they're not
 *    components.
 * 2. Skip the `default` export — the data-driven
 *    `namedExport(["default"])` already handles it; emitting it again
 *    would produce duplicate units (the cross-pack dedup would catch
 *    them but at higher cost).
 * 3. Require PascalCase names. Lowercase exports returning JSX are
 *    typically render-prop helpers (`renderRow = (item) => <Row .../>`)
 *    or other utilities, not components.
 */
export const reactComponentExports: NonNullable<
  PatternPack["discoverUnits"]
> = (sourceFile, ctx) => {
  const sf = sourceFile as SourceFile;
  const tsCtx = ctx as TsDiscoveryContext;

  const filePath = tsCtx.getFilePath(sf);
  if (STORY_FILE_PATTERN.test(filePath) || TEST_FILE_PATTERN.test(filePath)) {
    return [];
  }

  const out: DiscoveredCustomUnit[] = [];
  for (const { name, func, isDefault } of tsCtx.exportedFunctions(sf)) {
    if (isDefault) {
      continue;
    }
    if (!startsWithUppercase(name)) {
      continue;
    }
    if (!tsCtx.hasJsxReturn(func as FunctionRoot)) {
      continue;
    }
    out.push({
      func,
      kind: "component",
      name,
    });
  }
  return out;
};
