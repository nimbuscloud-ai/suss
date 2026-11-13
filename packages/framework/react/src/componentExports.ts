// React's conventions for what counts as a component live in this pack
// so the extractor stays free of them. The README lists the conventions.

import type {
  FunctionRoot,
  TsDiscoveryContext,
} from "@suss/adapter-typescript";
import type { DiscoveredCustomUnit, PatternPack } from "@suss/extractor";
import type { Node, SourceFile } from "ts-morph";

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
 * Finds every named export whose function has a statement that returns
 * JSX, and records it as a component.
 *
 * Story and test files are skipped, since their exports return JSX too.
 * The default export is skipped because `namedExport(["default"])`
 * already covers it, and a second unit for it would have to be removed
 * by the cross-pack dedup later. A lowercase export that returns JSX is
 * skipped, because it is usually a render-prop helper such as
 * `renderRow = (item) => <Row />`.
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

  const followed = new Map<string, unknown>(
    tsCtx.exportedFunctions(sf).map(({ name, func }) => [name, func]),
  );
  const out: DiscoveredCustomUnit[] = [];
  for (const [name, [first]] of tsCtx.resolution.exportsOf(sf)) {
    if (!startsWithUppercase(name)) {
      continue;
    }
    const func = followed.get(name) ?? factoryMade(first, tsCtx);
    if (func === null || !tsCtx.hasJsxReturn(func as FunctionRoot)) {
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

/**
 * The component a project factory gives back for an export it makes,
 * `export const Label = styledDiv("label")`, since that is what renders.
 */
function factoryMade(
  declaration: Node | undefined,
  ctx: TsDiscoveryContext,
): Node | null {
  return declaration === undefined
    ? null
    : ctx.resolution.resolveReturnedCallable(declaration);
}
