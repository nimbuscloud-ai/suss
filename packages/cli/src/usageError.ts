// usageError.ts: the error kind the dispatch prints as a sentence.
//
// It lives on its own so every command can throw it. It started inside
// extract.ts and only extract's dispatch branch caught it, which meant
// `suss inspect notes.json` and `suss check --dir summaries/` printed
// eight frames of bundled `dist/bin.js` on top of a message that was
// already a good sentence. A person reads that as "my input broke the
// tool", not "I pointed it at the wrong file".

/**
 * Something the person running the command can fix by typing something
 * else. The dispatch prints the sentence and stops; a stack trace above
 * a message about a missing flag helps nobody.
 */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}
