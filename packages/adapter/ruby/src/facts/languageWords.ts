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

/** The methods that convert the value they are called on to another type. */
export const CONVERTING_METHODS: ReadonlySet<string> = new Set([
  "to_i",
  "to_s",
  "to_f",
  "to_sym",
]);

/** Kernel's functions that convert their first argument to another type. */
export const CONVERTING_FUNCTIONS: ReadonlySet<string> = new Set([
  "Integer",
  "String",
  "Float",
]);

/**
 * Methods every Ruby object has from `Object` and `Kernel`. A module that
 * calls one of these bare runs the language's own method, whichever
 * class includes it.
 */
export const OBJECT_METHODS: ReadonlySet<string> = new Set([
  "Array",
  "Float",
  "Hash",
  "Integer",
  "String",
  "abort",
  "binding",
  "block_given?",
  "caller",
  "catch",
  "class",
  "clone",
  "define_singleton_method",
  "dup",
  "eql?",
  "equal?",
  "eval",
  "exit",
  "extend",
  "fail",
  "format",
  "freeze",
  "frozen?",
  "hash",
  "inspect",
  "instance_of?",
  "instance_variable_defined?",
  "instance_variable_get",
  "instance_variable_set",
  "instance_variables",
  "is_a?",
  "itself",
  "kind_of?",
  "lambda",
  "loop",
  "method",
  "methods",
  "nil?",
  "object_id",
  "p",
  "pp",
  "print",
  "printf",
  "proc",
  "public_send",
  "puts",
  "raise",
  "rand",
  "require",
  "require_relative",
  "respond_to?",
  "send",
  "singleton_class",
  "sleep",
  "sprintf",
  "srand",
  "system",
  "tap",
  "then",
  "throw",
  "to_s",
  "warn",
  "yield_self",
]);

/**
 * The method every Ruby class runs to make one of itself. An instance
 * has no `new`, so a read of it keeps its plain name wherever it is
 * written, and the one rule for a construction matches that name.
 */
export const CONSTRUCTOR = "new";
