/**
 * inflect.ts: the default inflections ActiveSupport ships, which is how
 * `has_many :statuses` says Status without writing Status down.
 *
 * The rules and their order are ActiveSupport's own, copied from the
 * `inflections.rb` it loads before a project's initializers run. A
 * project may teach the inflector more words in
 * `config/initializers/inflections.rb`; that file is not read, so a word
 * it covers is inflected here the default way and the association points
 * at a name the project declares nowhere. Such a declaration then says
 * nothing rather than saying something wrong.
 */

/**
 * A plural and the singular it comes from, in the order ActiveSupport
 * declares them. Each new rule is put in front of the ones before it, so
 * the search runs from the end of this list and stops at the first match.
 */
const SINGULAR_RULES: readonly (readonly [RegExp, string])[] = [
  [/s$/i, ""],
  [/(ss)$/i, "$1"],
  [/(n)ews$/i, "$1ews"],
  [/([ti])a$/i, "$1um"],
  [
    /((a)naly|(b)a|(d)iagno|(p)arenthe|(p)rogno|(s)ynop|(t)he)(sis|ses)$/i,
    "$1sis",
  ],
  [/(^analy)(sis|ses)$/i, "$1sis"],
  [/([^f])ves$/i, "$1fe"],
  [/(hive)s$/i, "$1"],
  [/(tive)s$/i, "$1"],
  [/([lr])ves$/i, "$1f"],
  [/([^aeiouy]|qu)ies$/i, "$1y"],
  [/(s)eries$/i, "$1eries"],
  [/(m)ovies$/i, "$1ovie"],
  [/(x|ch|ss|sh)es$/i, "$1"],
  [/^(m|l)ice$/i, "$1ouse"],
  [/(bus)(es)?$/i, "$1"],
  [/(o)es$/i, "$1"],
  [/(shoe)s$/i, "$1"],
  [/(cris|test)(is|es)$/i, "$1is"],
  [/^(a)x[ie]s$/i, "$1xis"],
  [/(octop|vir)(us|i)$/i, "$1us"],
  [/(alias|status)(es)?$/i, "$1"],
  [/^(ox)en/i, "$1"],
  [/(vert|ind)ices$/i, "$1ex"],
  [/(matr)ices$/i, "$1ix"],
  [/(quiz)zes$/i, "$1"],
  [/(database)s$/i, "$1"],
  // The words ActiveSupport calls irregular. It declares them after the
  // rules above, which is what puts them ahead in the search.
  [/(p)erson$/i, "$1erson"],
  [/(p)eople$/i, "$1erson"],
  [/(m)an$/i, "$1an"],
  [/(m)en$/i, "$1an"],
  [/(c)hild$/i, "$1hild"],
  [/(c)hildren$/i, "$1hild"],
  [/(s)ex$/i, "$1ex"],
  [/(s)exes$/i, "$1ex"],
  [/(m)ove$/i, "$1ove"],
  [/(m)oves$/i, "$1ove"],
  [/(z)ombie$/i, "$1ombie"],
  [/(z)ombies$/i, "$1ombie"],
];

/** Words ActiveSupport says are spelled the same in both numbers. */
const UNCOUNTABLE: ReadonlySet<string> = new Set([
  "equipment",
  "information",
  "rice",
  "money",
  "species",
  "series",
  "fish",
  "sheep",
  "jeans",
  "police",
]);

/** The singular of a word, the way ActiveSupport's `singularize` reads it. */
export function singularize(word: string): string {
  if (UNCOUNTABLE.has(word.toLowerCase())) {
    return word;
  }
  for (let at = SINGULAR_RULES.length - 1; at >= 0; at--) {
    const [pattern, replacement] = SINGULAR_RULES[at] as readonly [
      RegExp,
      string,
    ];
    if (pattern.test(word)) {
      return word.replace(pattern, replacement);
    }
  }
  return word;
}

/** The constant name a snake_case word becomes: `media_attachment` is `MediaAttachment`. */
export function camelize(word: string): string {
  return word
    .split("_")
    .map((part) => (part === "" ? "" : part[0].toUpperCase() + part.slice(1)))
    .join("");
}

/**
 * The class an association of this name targets when the declaration
 * does not say which. A call spelled in the plural, `has_many
 * :statuses`, is singularised first.
 */
export function associationTargetName(name: string, plural: boolean): string {
  return camelize(plural ? singularize(name) : name);
}
