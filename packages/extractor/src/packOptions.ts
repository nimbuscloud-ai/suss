/**
 * Option declarations more than one pack takes.
 *
 * A pack exports `optionsSchema` beside its factory, and the CLI parses
 * a `-f pack=config.json` file against it before the factory runs, so an
 * undeclared key is refused by name instead of being silently ignored.
 *
 * Four packs accept `storageSystem` and three accept `scope`, so each
 * option is declared once here. With a copy per pack, one pack can end up
 * accepting a value the others reject.
 */

import { z } from "zod";

/**
 * Which database is behind the connection, spelled the way the
 * provider summaries spell it. Both sides build a pairing key from
 * this, so a value only one side would write stops the two pairing
 * with nothing said about why.
 */
export const storageSystemOption = z.enum([
  "postgresql",
  "mysql",
  "sqlite",
] as const);

/**
 * Which of a project's connections an access belongs to, matched
 * against the scope the provider summaries carry. Packs default it to
 * `"default"`, so a project with one connection never sets it.
 */
export const scopeOption = z.string();

/**
 * A method on a dispatcher of the project's own, matched by the type of
 * the receiver it is called on.
 *
 * `receiver` is a type name because a service may keep its dispatcher in
 * a field, a closure or a constructor parameter, and the type is the same
 * in all three.
 */
const receiverCallOption = z
  .object({
    /** Module that declares the receiver's type. */
    module: z.string(),
    /**
     * The export a drafted stub writes, such as `CommandDispatcher.dispatch`.
     * The receiver and the method decide which calls match, so a stub
     * that keeps the drafted export beside them matches the same calls.
     */
    export: z.string().optional(),
    /** Type name of the receiver, as exported from that module. */
    receiver: z.string(),
    /** Method that performs the send. */
    method: z.string(),
    /** Index of the argument that is the subject. */
    subjectArg: z.number(),
    /**
     * Which argument the message body is. Left out when the method has no
     * single body argument, as a batch method taking a list of entries
     * does, and then no body is reported.
     */
    bodyArg: z.number().optional(),
  })
  .strict();

/** Which argument of a call a value is, counting from 0. */
const argumentPosition = z.object({ at: z.number().int().min(0) }).strict();

/**
 * An export of the module that sends when called, whether the project
 * calls it bare or through the object it imported the module as.
 */
const exportCallOption = z
  .object({
    /** Module the export comes from. */
    module: z.string(),
    /**
     * The export as `suss infer stub` writes it: `publishEntry`, or
     * `Client.send` for a method on an instance the project makes.
     */
    export: z.string(),
    /** Which argument is the subject. */
    subject: argumentPosition,
    /** Which argument is the message body. Left out, no body is reported. */
    payload: argumentPosition.optional(),
  })
  .strict();

/**
 * A call the project has declared to be its own dispatcher, which both
 * message-bus packs take under `producers`. A dependency stub can write
 * it either way. Both forms are strict, so a key neither form reads is
 * refused rather than ignored.
 */
export const configuredCallOption = z.union([
  receiverCallOption,
  exportCallOption,
]);
