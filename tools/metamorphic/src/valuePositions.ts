// Where each pack reads a value, read off the shipped pack objects.
//
// Every position a pack reads a value at is in its own declaration, so
// this derives the list instead of keeping one. A pack joins the
// matrix by existing, and a position a pack stops declaring leaves the
// matrix with it.
//
// v0 covers the path positions of HTTP packs: registration calls, client
// calls and `httpRequests` methods that read the URL off an argument.
// Positions inside other recognize chains wait for their own pass.

import { byOrigin } from "@suss/extractor";

import type {
  ByOrigin,
  DiscoveryPattern,
  Imported,
  PatternPack,
} from "@suss/extractor";
import type { HttpRequests } from "@suss/recognize";

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

/** A pack declared with `httpRequests`, and the chain it declares. */
export interface DeclaredRequests {
  readonly pack: PatternPack;
  readonly chain: HttpRequests;
}

/** How a program writes the client a request chain's calls are made on. */
interface WrittenClient {
  /** The name the program calls the client by. */
  readonly name: string;
  /** The module and export it is imported as, or null for a name the runtime provides. */
  readonly from: { readonly module: string; readonly export: string } | null;
}

const NOT_WRITTEN = (): WrittenClient | null => null;

function importedClient({
  importedFrom,
  named,
}: Imported): WrittenClient | null {
  const [module] = importedFrom;
  const [exported = "default"] = named ?? [];
  if (module === undefined || exported === "*") {
    return null;
  }
  const name = exported === "default" ? "client" : exported;
  return { name, from: { module, export: exported } };
}

/** The first way of writing the client that the origin accepts, or null for one no name or import says. */
const WRITTEN: ByOrigin<WrittenClient | null> = {
  spelled: ({ names }) =>
    names[0] === undefined ? null : { name: names[0], from: null },
  imported: importedClient,
  anyOf: ({ of }) =>
    of.map((one) => byOrigin(WRITTEN, one)).find((one) => one !== null) ?? null,
  global: NOT_WRITTEN,
  allOf: NOT_WRITTEN,
  declaredBy: NOT_WRITTEN,
  constructed: NOT_WRITTEN,
  returnedBy: NOT_WRITTEN,
  typed: NOT_WRITTEN,
  inherits: NOT_WRITTEN,
  handedBy: NOT_WRITTEN,
  readOff: NOT_WRITTEN,
};

/** The methods of the chain that read the URL off the first argument whole. */
function methodsReadingFirstArgument(chain: HttpRequests): string[] {
  return chain.declared.links.flatMap((link) =>
    link.asks === "methods"
      ? Object.entries(link.table)
          .filter(
            ([, meaning]) =>
              "url" in meaning &&
              meaning.url.at === 0 &&
              meaning.url.property === undefined &&
              meaning.url.hostFirst === undefined,
          )
          .map(([method]) => method)
      : [],
  );
}

/** A module whose default export, and its named export when the client is one, is a client with these methods. */
function clientLibrary(
  from: NonNullable<WrittenClient["from"]>,
  methods: readonly string[],
): Readonly<Record<string, string>> {
  const named =
    from.export === "default" ? "" : `export { client as ${from.export} };`;
  return {
    [`/node_modules/${from.module}/package.json`]: JSON.stringify({
      name: from.module,
      types: "index.d.ts",
    }),
    [`/node_modules/${from.module}/index.d.ts`]: `
      declare const client: {
        (url: string): Promise<unknown>;
        ${methods.map((method) => `${method}(url: string): Promise<unknown>;`).join("\n")}
      };
      export default client;
      ${named}
    `,
  };
}

function importOf(client: WrittenClient): string {
  if (client.from === null) {
    return "";
  }
  const { module, export: exported } = client.from;
  return exported === "default"
    ? `import ${client.name} from "${module}";`
    : `import { ${exported} } from "${module}";`;
}

/**
 * The path positions one request chain declares, one per method that
 * reads the URL off the first argument. A method named as the client
 * itself, `fetch`, is called bare.
 */
export function requestPositionsOf({
  pack,
  chain,
}: DeclaredRequests): ValuePosition[] {
  const start = chain.declared.links.find((link) => link.asks === "start");
  const client =
    start?.asks === "start" ? byOrigin(WRITTEN, start.at.origin) : null;
  if (client === null) {
    return [];
  }
  const methods = methodsReadingFirstArgument(chain);
  const files = client.from === null ? {} : clientLibrary(client.from, methods);
  return methods.map((method) => {
    const call =
      method === client.name && client.from === null
        ? `${method}(EXPR)`
        : `${client.name}.${method}(EXPR)`;
    return {
      name: `${pack.name} path from argument 0 of ${call.replace("EXPR", "...")}`,
      pack,
      files,
      program: (spelled) => `
        ${importOf(client)}
        ${spelled.prelude}
        export async function go(id: string) {
          return ${call.replace("EXPR", spelled.expression)};
        }
      `,
    };
  });
}
