// usageError.ts: the error kind the dispatch prints as a sentence.
//
// It lives on its own so every command can throw it. It started inside
// extract.ts, where only extract's dispatch branch caught it, which
// meant `suss inspect notes.json` and `suss check --dir summaries/`
// printed eight frames of bundled `dist/bin.js` on top of a message
// that was already a good sentence. A person reads that as "my input
// broke the tool" rather than "I pointed it at the wrong file".

/** The dispatch prints this message alone, with no stack trace. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}
