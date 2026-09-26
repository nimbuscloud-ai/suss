/**
 * What Ruby's own methods do, said the way a pack says what its library
 * does. `%i[a b].freeze` and `list.dup` hand back the object they are
 * called on, so a name written as either one is the list. No file suss
 * reads says so, because both methods are part of the language.
 *
 * The resolution rules and the value evaluator read the same list, so a
 * value followed across files and one settled inside a file agree.
 */

export const RECEIVER_RETURNS: readonly string[] = ["freeze", "dup"];

/**
 * The method every Ruby class runs to make one of itself. An instance
 * has no `new`, so a read of it keeps its plain name wherever it is
 * written, and the one rule for a construction matches that name.
 */
export const CONSTRUCTOR = "new";
