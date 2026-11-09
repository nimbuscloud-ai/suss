/**
 * Where a module specifier points, as the paths the compiler would try
 * for it, without asking whether anything is there. A generator's output
 * directory exists only after the generator has run, and a pack asks
 * about an import into it by the directory all the same.
 *
 * A relative specifier points beside the importing file. A bare one
 * points where the project's `paths` map it, or, when no pattern there
 * covers it, under `baseUrl`. That is the order the compiler tries, and
 * a pattern that matches decides on its own. A bare specifier neither
 * covers points nowhere, since it is a package.
 */

import path from "node:path";

import type { ts } from "ts-morph";

export function specifierTargets(
  fromFile: string,
  specifier: string,
  options: ts.CompilerOptions,
): string[] {
  if (specifier.startsWith(".")) {
    return [path.resolve(path.dirname(fromFile), specifier)];
  }
  const mapped = pathsTargets(specifier, options);
  if (mapped !== null) {
    return mapped;
  }
  return options.baseUrl === undefined
    ? []
    : [path.resolve(options.baseUrl, specifier)];
}

/**
 * The substitutions of the `paths` key that covers the specifier, or null
 * when none does. An exact key wins over a pattern, and among patterns
 * the longest prefix wins.
 */
function pathsTargets(
  specifier: string,
  options: ts.CompilerOptions,
): string[] | null {
  const paths = options.paths;
  const base = options.baseUrl ?? options.pathsBasePath;
  if (paths === undefined || typeof base !== "string") {
    return null;
  }
  const match = bestPathsMatch(Object.keys(paths), specifier);
  if (match === null) {
    return null;
  }
  return paths[match.key].map((substitution) =>
    path.resolve(base, substitution.replace("*", match.star)),
  );
}

function bestPathsMatch(
  keys: readonly string[],
  specifier: string,
): { key: string; star: string } | null {
  if (keys.includes(specifier)) {
    return { key: specifier, star: "" };
  }
  let best: { key: string; star: string; prefix: number } | null = null;
  for (const key of keys) {
    const star = starMatched(key, specifier);
    if (star === null) {
      continue;
    }
    const prefix = key.indexOf("*");
    if (best === null || prefix > best.prefix) {
      best = { key, star, prefix };
    }
  }
  return best;
}

/** The text a `prefix*suffix` key's star matches in the specifier, or null. */
function starMatched(key: string, specifier: string): string | null {
  const star = key.indexOf("*");
  if (star === -1 || key.indexOf("*", star + 1) !== -1) {
    return null;
  }
  const prefix = key.slice(0, star);
  const suffix = key.slice(star + 1);
  if (
    specifier.length < prefix.length + suffix.length ||
    !specifier.startsWith(prefix) ||
    !specifier.endsWith(suffix)
  ) {
    return null;
  }
  return specifier.slice(prefix.length, specifier.length - suffix.length);
}
