// The ways the language writes one string value, each labelled with
// what a correct reader gives back.
//
// A reader that is right gives the same answer for every resolvable
// spelling, and an abstention rather than a wrong value for the rest.
// Which of the two a spelling belongs to is a property of the
// language, not of any pack, which is why the catalog lives here and
// the packs only contribute where their values sit.
//
// Two bugs this axis found before it existed: a route path built by
// concatenation read as no route at all (#604), and a template whose
// prefix resolved to a constant kept the hole (#603). The fixtures
// write literals, so neither had anything to fail.

/** What one spelling contributes to the program. */
export interface SpelledValue {
  /** The expression to put in the value position. */
  readonly expression: string;
  /** Statements above the call, in the same module. */
  readonly prelude: string;
  /** Other files the spelling needs, by path. */
  readonly files: Readonly<Record<string, string>>;
}

export interface Spelling {
  /** What a failure prints, so it says which spelling was lost. */
  readonly name: string;
  /**
   * Whether the language settles this spelling to the value. A reader
   * must give the settled answer for these, and must not claim a
   * concrete value for the rest.
   */
  readonly settles: boolean;
  /** How the settled answer differs from the plain value, when it does. */
  readonly answer?: (value: string) => string;
  readonly render: (value: string) => SpelledValue;
}

const plain = (expression: string, prelude = ""): SpelledValue => ({
  expression,
  prelude,
  files: {},
});

export const SPELLINGS: readonly Spelling[] = [
  {
    name: "a literal",
    settles: true,
    render: (value) => plain(JSON.stringify(value)),
  },
  {
    name: "a no-substitution template",
    settles: true,
    render: (value) => plain(`\`${value}\``),
  },
  {
    name: "a const in the same module",
    settles: true,
    render: (value) => plain("P", `const P = ${JSON.stringify(value)};`),
  },
  {
    name: "a let nobody reassigns",
    settles: true,
    render: (value) => plain("P", `let P = ${JSON.stringify(value)};`),
  },
  {
    name: "a const declared as const",
    settles: true,
    render: (value) =>
      plain("P", `const P = ${JSON.stringify(value)} as const;`),
  },
  {
    name: "a const imported from another module",
    settles: true,
    render: (value) => ({
      expression: "P",
      prelude: `import { P } from "./values.js";`,
      files: {
        "/app/values.ts": `export const P = ${JSON.stringify(value)};\n`,
      },
    }),
  },
  {
    name: "a property of an object literal",
    settles: true,
    render: (value) =>
      plain(
        "ROUTES.it",
        `const ROUTES = { it: ${JSON.stringify(value)} } as const;`,
      ),
  },
  {
    name: "a concatenation of two literals",
    settles: true,
    render: (value) => {
      const cut = Math.max(1, Math.floor(value.length / 2));
      const left = JSON.stringify(value.slice(0, cut));
      const right = JSON.stringify(value.slice(cut));
      return plain(`${left} + ${right}`);
    },
  },
  {
    name: "a const built by concatenation",
    settles: true,
    render: (value) => {
      const cut = Math.max(1, Math.floor(value.length / 2));
      const left = JSON.stringify(value.slice(0, cut));
      const right = JSON.stringify(value.slice(cut));
      return plain("P", `const P = ${left} + ${right};`);
    },
  },
  {
    name: "a template whose prefix resolves",
    settles: true,
    answer: (value) => `/api${value}`,
    render: (value) => plain(`\`\${BASE}${value}\``, `const BASE = "/api";`),
  },
  {
    name: "a template hole nobody can follow",
    settles: false,
    render: (value) =>
      plain(`\`\${pfx}${value}\``, "declare const pfx: string;"),
  },
  {
    name: "a value nothing settles",
    settles: false,
    render: () => plain("P", "declare const P: string;"),
  },
];
