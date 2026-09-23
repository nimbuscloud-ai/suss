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
 * A call the project has declared to be its own dispatcher, which both
 * message-bus packs take under `producers`.
 *
 * `receiver` is a type name because a service may keep its dispatcher in
 * a field, a closure or a constructor parameter, and the type is the same
 * in all three.
 */
export const configuredCallOption = z
  .object({
    /** Module that declares the receiver's type. */
    module: z.string(),
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
