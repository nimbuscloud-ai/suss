/**
 * The default inflections ActiveSupport ships. They are how
 * `has_many :statuses` reaches `Status` without the source writing
 * `Status` anywhere.
 *
 * The rules and their order are copied from the `inflections.rb`
 * ActiveSupport loads before a project's initializers run. The words a
 * project adds to its own inflector come from the pack as
 * `RbInflections`, and are searched before these, the way ActiveSupport
 * searches the newest rule first.
 */

import type { RbInflections } from "./pack.js";

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
  // ActiveSupport's irregular words. It declares them after the rules
  // above, so they come first in the search.
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

/** Words ActiveSupport spells the same in the singular and the plural. */
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

/**
 * A singular and the plural it gives, in the order ActiveSupport declares
 * them, searched from the end the way `SINGULAR_RULES` are.
 */
const PLURAL_RULES: readonly (readonly [RegExp, string])[] = [
  [/$/, "s"],
  [/s$/i, "s"],
  [/^(ax|test)is$/i, "$1es"],
  [/(octop|vir)us$/i, "$1i"],
  [/(octop|vir)i$/i, "$1i"],
  [/(alias|status)$/i, "$1es"],
  [/(bu)s$/i, "$1ses"],
  [/(buffal|tomat)o$/i, "$1oes"],
  [/([ti])um$/i, "$1a"],
  [/([ti])a$/i, "$1a"],
  [/sis$/i, "ses"],
  [/(?:([^f])fe|([lr])f)$/i, "$1$2ves"],
  [/(hive)$/i, "$1s"],
  [/([^aeiouy]|qu)y$/i, "$1ies"],
  [/(x|ch|ss|sh)$/i, "$1es"],
  [/(matr|vert|ind)(?:ix|ex)$/i, "$1ices"],
  [/^(m|l)ouse$/i, "$1ice"],
  [/^(m|l)ice$/i, "$1ice"],
  [/^(ox)$/i, "$1en"],
  [/^(oxen)$/i, "$1"],
  [/(quiz)$/i, "$1zes"],
  [/(p)erson$/i, "$1eople"],
  [/(p)eople$/i, "$1eople"],
  [/(m)an$/i, "$1en"],
  [/(m)en$/i, "$1en"],
  [/(c)hild$/i, "$1hildren"],
  [/(c)hildren$/i, "$1hildren"],
  [/(s)ex$/i, "$1exes"],
  [/(s)exes$/i, "$1exes"],
  [/(m)ove$/i, "$1oves"],
  [/(m)oves$/i, "$1oves"],
  [/(z)ombie$/i, "$1ombies"],
  [/(z)ombies$/i, "$1ombies"],
];

/** The singular of a word, the way ActiveSupport's `singularize` computes it. */
export function singularize(word: string, project?: RbInflections): string {
  if (isUncountable(word, project)) {
    return word;
  }
  return (
    projectSingular(word, project) ?? lastMatching(SINGULAR_RULES, word) ?? word
  );
}

/**
 * The plural of a word, the way ActiveSupport's `pluralize` computes it.
 * A project's own `inflect.plural` rules are not read, since the pack
 * reads only the irregular and uncountable words a project declares.
 */
export function pluralize(word: string, project?: RbInflections): string {
  if (isUncountable(word, project)) {
    return word;
  }
  return (
    projectPlural(word, project) ?? lastMatching(PLURAL_RULES, word) ?? word
  );
}

function isUncountable(word: string, project?: RbInflections): boolean {
  return (
    UNCOUNTABLE.has(word.toLowerCase()) ||
    (project?.uncountable ?? []).some(
      (uncountable) => uncountable.toLowerCase() === word.toLowerCase(),
    )
  );
}

/** The word with the last rule that matches it applied, or null when none does. */
function lastMatching(
  rules: readonly (readonly [RegExp, string])[],
  word: string,
): string | null {
  for (let at = rules.length - 1; at >= 0; at--) {
    const [pattern, replacement] = rules[at] as readonly [RegExp, string];
    if (pattern.test(word)) {
      return word.replace(pattern, replacement);
    }
  }
  return null;
}

/** The plural an irregular word the project declares gives, by either spelling, or null. A word declared later is searched first. */
function projectPlural(
  word: string,
  project: RbInflections | undefined,
): string | null {
  const irregular = [...(project?.irregular ?? [])].reverse();
  for (const [plural, singular] of irregular) {
    const lower = word.toLowerCase();
    if (singular.toLowerCase() === lower || plural.toLowerCase() === lower) {
      return matchingCase(word, plural);
    }
  }
  return null;
}

/** What the project's own rules make of the word, or null when none of them matches. A rule declared later is searched first. */
function projectSingular(
  word: string,
  project: RbInflections | undefined,
): string | null {
  const irregular = [...(project?.irregular ?? [])].reverse();
  for (const [plural, singular] of irregular) {
    if (plural.toLowerCase() === word.toLowerCase()) {
      return matchingCase(word, singular);
    }
  }
  const rules = [...(project?.singular ?? [])].reverse();
  for (const [rule, replacement] of rules) {
    const applied = applyRule(word, rule, replacement);
    if (applied !== null) {
      return applied;
    }
  }
  return null;
}

/** A rule written `/body/flags` is a pattern; anything else is the text to replace, the way Ruby's `sub` takes a string. */
function applyRule(
  word: string,
  rule: string,
  replacement: string,
): string | null {
  const written = /^\/(.*)\/([a-z]*)$/s.exec(rule);
  if (written === null) {
    return word.includes(rule) ? word.replace(rule, replacement) : null;
  }
  // Ruby's `m` makes the dot match a newline, which JavaScript spells `s`.
  const flags = (written[2] ?? "").replace("m", "s").replace(/[^is]/g, "");
  const pattern = new RegExp(written[1] ?? "", flags);
  return pattern.test(word)
    ? word.replace(pattern, replacement.replace(/\\(\d)/g, "$$$1"))
    : null;
}

/** The replacement with its first letter's case taken from the word it replaces, as ActiveSupport does for an irregular word. */
function matchingCase(word: string, replacement: string): string {
  const first = word[0];
  if (first === undefined || first !== first.toUpperCase()) {
    return replacement;
  }
  return replacement.charAt(0).toUpperCase() + replacement.slice(1);
}

/** The constant name a snake_case word becomes: `media_attachment` is `MediaAttachment`, and `api_token` is `APIToken` where the project registered `API`. */
export function camelize(
  word: string,
  acronyms: readonly string[] = [],
): string {
  return word
    .split("_")
    .map((part) => capitalize(part, acronyms))
    .join("");
}

function capitalize(part: string, acronyms: readonly string[]): string {
  if (part === "") {
    return "";
  }
  const acronym = acronyms.find(
    (known) => known.toLowerCase() === part.toLowerCase(),
  );
  return acronym ?? part[0]?.toUpperCase() + part.slice(1);
}

/**
 * The class an association of this name targets when the declaration
 * does not say which. A call spelled in the plural, `has_many
 * :statuses`, is singularised first.
 */
export function associationTargetName(
  name: string,
  plural: boolean,
  project?: RbInflections,
): string {
  return camelize(
    plural ? singularize(name, project) : name,
    project?.acronyms ?? [],
  );
}
