/**
 * Options a pack used to take and no longer does, because suss reads
 * the same fact off the project's own code.
 *
 * The pack schema drops the key, so without this table a project that
 * still sets one is told it is not an option this pack takes, and goes
 * looking for a typo. What they need instead is the sentence saying
 * what suss does now, and that they can delete the entry. None of
 * these is a dependency fact, so none of them points at a stub.
 */

/**
 * Every HTTP pack retired the same option, so the sentence is written
 * once and each pack points at it.
 */
const REGISTRATION_HELPERS =
  "suss reads the helper itself. Before extraction it finds every function " +
  "your code hands its app to, reads what each one registers in terms of " +
  "its own parameters, and fills those in at each call site, so a helper " +
  "called twice gives both routes. Take it out of your config and the " +
  "routes still come back.";

const RETIRED: Record<string, Record<string, string>> = {
  express: { registrationHelpers: REGISTRATION_HELPERS },
  fastify: { registrationHelpers: REGISTRATION_HELPERS },
  hono: { registrationHelpers: REGISTRATION_HELPERS },
  "aws-dynamodb": {
    requestFunctions:
      "suss reads the helper itself. A function that posts a DynamoDB " +
      "request states the operation in the X-Amz-Target header and the " +
      "request as the body, so before extraction suss works out which " +
      "parameter reaches each and matches the call sites. What each " +
      "operation does to the table is built into the pack. Take it out of " +
      "your config and the accesses still come back.",
  },
  "aws-lambda": {
    subjectFactories:
      "The queue in front of a consumer is its boundary, and suss takes that from " +
      "the SAM template's event source. The subject your factory states is a field " +
      "of the message, which `suss check` compares against what producers send. " +
      "Take it out of your config and the consumer still gets its boundary.",
  },
};

/** Which of these keys the pack used to take, in the order given. */
export function retiredOptionsUsed(
  packName: string,
  keys: readonly string[],
): string[] {
  const retired = RETIRED[packName];
  if (retired === undefined) {
    return [];
  }
  return keys.filter((key) => key in retired);
}

/** One line per retired key somebody still has in a config file. */
export function retiredOptionRefusal(
  packName: string,
  used: readonly string[],
): string[] {
  const retired = RETIRED[packName] ?? {};
  return used.map((key) => `${key} is gone. ${retired[key] ?? ""}`.trimEnd());
}

/**
 * The release these stop being read at all.
 *
 * 0.20.0 told everyone setting one of these to write a dependency stub,
 * and for these three that was the wrong instruction: they describe the
 * project's own code, a stub cannot spell one, and the reading that
 * replaces them only arrived in 0.21.0. So the warning they were given
 * pointed nowhere, and they get a release with a true one instead.
 */
const REMOVED_IN = "0.22.0";

/** What somebody setting one of these reads, loudly, on every run. */
export function retiredOptionWarning(
  packName: string,
  used: readonly string[],
): string {
  const retired = RETIRED[packName] ?? {};
  const lines = used.map((key) => `  ${key}: ${retired[key] ?? ""}`.trimEnd());
  const plural = used.length > 1;
  return [
    "",
    `[suss] The ${packName} pack ignores ${used.join(" and ")}. ` +
      `suss reads the same thing off your code now, so the option change${plural ? "" : "s"} nothing.`,
    ...lines,
    `  Delete ${plural ? "them" : "it"} from your config. suss stops reading ${plural ? "these keys" : "this key"} in ${REMOVED_IN} and a run that sets ${plural ? "one" : "it"} will fail.`,
    "",
  ].join("\n");
}
