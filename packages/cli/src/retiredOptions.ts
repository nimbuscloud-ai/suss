/**
 * Pack options that suss no longer accepts, because it now reads the same
 * fact from the project's code.
 *
 * The pack schema no longer lists these keys. Without this table, a
 * project that still sets one would be told the pack has no such option,
 * and the user would go looking for a typo. The messages here say what
 * suss does instead and that the entry can be deleted. None of these
 * options describes a dependency, so none of the messages suggests a stub.
 */

// The three HTTP packs dropped the same option, so they share one message.
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

/** The keys in `keys` that the pack no longer accepts, in the order given. */
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

/** One error line for each retired key that a config file still sets. */
export function retiredOptionRefusal(
  packName: string,
  used: readonly string[],
): string[] {
  const retired = RETIRED[packName] ?? {};
  return used.map((key) => `${key} is gone. ${retired[key] ?? ""}`.trimEnd());
}

/** The warning printed on every run while a config still sets a retired key. */
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
    `  Delete ${plural ? "them" : "it"} from your config.`,
    "",
  ].join("\n");
}
