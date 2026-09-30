/**
 * What the run says about a unit whose body threw while it was read. The
 * unit's summary still comes out, with the sentence returned here as a
 * gap, and whoever ran the extract sees the same error on stderr.
 */
export function reportReadFailure(
  unitName: string,
  file: string,
  error: unknown,
): string {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(
    `[suss] could not read ${unitName} in ${file}, so its summary describes none of its body: ${message}\n`,
  );
  return `Reading this unit's body failed with "${message}", so nothing about what it does is described here`;
}
