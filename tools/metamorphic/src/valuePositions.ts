// Where each pack reads a value, read off the shipped pack objects.
//
// Every position a pack reads a value at is in its own declaration, so
// this derives the list instead of keeping one. A pack joins the
// matrix by existing, and a position a pack stops declaring leaves the
// matrix with it.
//
// v0 covers the path positions of HTTP discovery packs: registration
// calls reading an argument, and client calls reading an argument.
// Positions declared inside recognize chains are a different reader
// and wait for their own pass.

import type { DiscoveryPattern, PatternPack } from "@suss/extractor";

/** One place a pack reads a path, and how to write a program that puts
 * a value there. */
export interface ValuePosition {
  /** What a failure prints: pack, position, and how it is read. */
  readonly name: string;
  readonly pack: PatternPack;
  /** The program, given the spelled value's parts. */
  readonly program: (spelled: {
    expression: string;
    prelude: string;
  }) => string;
  /** Files every program at this position needs, the library among them. */
  readonly files: Readonly<Record<string, string>>;
}

/** Library declarations for one module: a callable that yields a
 * routable with the pack's registration methods on it. */
function routableLibrary(
  importModule: string,
  importName: string,
  method: string,
): Readonly<Record<string, string>> {
  return {
    [`/node_modules/${importModule}/package.json`]: JSON.stringify({
      name: importModule,
      types: "index.d.ts",
    }),
    [`/node_modules/${importModule}/index.d.ts`]: `
      export interface Routable {
        ${method}(path: string, handler: (req: unknown, res: unknown) => void): void;
      }
      export declare function ${importName}(): Routable;
    `,
  };
}

function registrationPosition(
  pack: PatternPack,
  match: Extract<DiscoveryPattern["match"], { type: "registrationCall" }>,
): ValuePosition {
  const method = (match.registrationChain[0] ?? ".get").replace(/^\./, "");
  return {
    name: `${pack.name} path from argument 0 of .${method}`,
    pack,
    files: routableLibrary(match.importModule, match.importName, method),
    program: (spelled) => `
      import { ${match.importName} } from "${match.importModule}";
      ${spelled.prelude}
      const app = ${match.importName}();
      app.${method}(${spelled.expression}, (req: any, res: any) => {});
    `,
  };
}

function clientPosition(
  pack: PatternPack,
  match: Extract<DiscoveryPattern["match"], { type: "clientCall" }>,
): ValuePosition {
  const method = match.methodFilter?.[0];
  const isGlobal = match.importModule === "global";
  const call =
    method === undefined
      ? `${match.importName}(EXPR)`
      : `${match.importName}.${method}(EXPR)`;
  const files: Record<string, string> = isGlobal
    ? {}
    : {
        [`/node_modules/${match.importModule}/package.json`]: JSON.stringify({
          name: match.importModule,
          types: "index.d.ts",
        }),
        [`/node_modules/${match.importModule}/index.d.ts`]: `
          declare const client: {
            (url: string): Promise<unknown>;
            ${method === undefined ? "" : `${method}(url: string): Promise<unknown>;`}
          };
          export default client;
        `,
      };
  return {
    name: `${pack.name} path from argument 0 of ${call.replace("EXPR", "...")}`,
    pack,
    files,
    program: (spelled) => `
      ${isGlobal ? "" : `import ${match.importName} from "${match.importModule}";`}
      ${spelled.prelude}
      export async function go(id: string) {
        return ${call.replace("EXPR", spelled.expression)};
      }
    `,
  };
}

/** Whether the pattern reads its path out of an argument. */
function readsPathFromArgument(pattern: DiscoveryPattern): boolean {
  const path = pattern.bindingExtraction?.path;
  return path !== undefined && path.type === "fromArgument";
}

/**
 * The distinct path positions one pack declares. Two patterns reading
 * the same way through different imports are one position, since the
 * program they need differs only in a name.
 */
export function valuePositionsOf(pack: PatternPack): ValuePosition[] {
  const found = new Map<string, ValuePosition>();
  for (const pattern of pack.discovery) {
    if (!readsPathFromArgument(pattern)) {
      continue;
    }
    if (pattern.match.type === "registrationCall") {
      const position = registrationPosition(pack, pattern.match);
      found.set(position.name, position);
    }
    if (pattern.match.type === "clientCall") {
      const position = clientPosition(pack, pattern.match);
      found.set(position.name, position);
    }
  }
  return [...found.values()];
}
