/**
 * How a `test` unit is named. Every test pack names a test by its title
 * path, the suite titles outermost first and then the test's own, and a
 * PRD scenario's `coveredBy` entry is matched against that name, so the
 * adapters that write it and the check that reads it share this one
 * spelling.
 */

/** What joins the titles in a test unit's name, and the file and titles in a `coveredBy` entry. */
export const TEST_TITLE_SEPARATOR = " > ";

export function testUnitName(titles: readonly string[]): string {
  return titles.join(TEST_TITLE_SEPARATOR);
}
