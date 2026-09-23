// The error any command throws when the user's input is wrong, such as a
// summary path that points at the wrong file. Every command imports it from
// here so that one catch in the dispatch covers all of them.

/**
 * A mistake in the command line or in the files passed on it. The CLI
 * prints the message on its own, without a stack trace, so the user does
 * not mistake a wrong path for a crash in the tool.
 */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}
