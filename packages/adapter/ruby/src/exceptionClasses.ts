/**
 * What an exception class inherits from, so a raise can be matched with
 * the `rescue_from` handlers that catch it.
 *
 * A class the project defines is walked like any other class. Ruby's own
 * exception classes are listed here, since they are part of the language,
 * and a library's come from its pack. Any other class is one the run did
 * not read. It is an `Exception`, since Ruby raises nothing else, and
 * the rest of its ancestry is unknown. The run assumes such a class
 * inherits only from Ruby's classes or from other unread classes, never
 * from a project class or a class a pack lists. The package's DESIGN.md
 * says why.
 */

import { ancestryOf, reachConstant } from "./ancestry.js";

import type { AncestorLookup } from "./ancestry.js";
import type { LibraryException } from "./pack.js";
import type { ConstantRef } from "./scope.js";

/** Every exception a `raise` can make inherits from this one. */
const ROOT_EXCEPTION = "Exception";

/** Ruby's exception classes, each with the class it inherits from. */
const RUBY_EXCEPTION_PARENTS: Readonly<Record<string, string>> = {
  NoMemoryError: ROOT_EXCEPTION,
  ScriptError: ROOT_EXCEPTION,
  LoadError: "ScriptError",
  NotImplementedError: "ScriptError",
  SyntaxError: "ScriptError",
  SecurityError: ROOT_EXCEPTION,
  SignalException: ROOT_EXCEPTION,
  Interrupt: "SignalException",
  StandardError: ROOT_EXCEPTION,
  SystemExit: ROOT_EXCEPTION,
  SystemStackError: ROOT_EXCEPTION,
  ArgumentError: "StandardError",
  UncaughtThrowError: "ArgumentError",
  EncodingError: "StandardError",
  FiberError: "StandardError",
  IOError: "StandardError",
  EOFError: "IOError",
  IndexError: "StandardError",
  KeyError: "IndexError",
  StopIteration: "IndexError",
  ClosedQueueError: "StopIteration",
  LocalJumpError: "StandardError",
  NameError: "StandardError",
  NoMethodError: "NameError",
  RangeError: "StandardError",
  FloatDomainError: "RangeError",
  RegexpError: "StandardError",
  RuntimeError: "StandardError",
  FrozenError: "RuntimeError",
  SystemCallError: "StandardError",
  ThreadError: "StandardError",
  TypeError: "StandardError",
  ZeroDivisionError: "StandardError",
};

/** The class `raise "message"` makes. */
export const MESSAGE_ONLY_EXCEPTION = "RuntimeError";

/** One exception class, with what the run knows of its ancestry. */
export interface ExceptionClass {
  /** The qualified name it resolved to, or the name as written when the run did not read it. */
  name: string;
  /** The classes and modules it inherits from, as far as the run read them. */
  ancestors: string[];
  /** True when the ancestry reaches a class the run did not read. */
  incomplete: boolean;
  /** Whether a class the run did not read may inherit from this one. */
  inheritableByUnread: boolean;
}

/**
 * Reads the class a constant refers to, once per reference, over one
 * controller's lookup. `library` is what the pack lists. The walk of a
 * project class stops at any of those, or at one of Ruby's own, and takes
 * the rest of the ancestry from the list.
 */
export class ExceptionReader {
  private readonly walking: AncestorLookup;
  private readonly known = new Map<string, Promise<ExceptionClass>>();

  constructor(
    lookup: AncestorLookup,
    private readonly library: Readonly<Record<string, LibraryException>>,
  ) {
    this.walking = {
      ...lookup,
      ancestryRootClassNames: [
        ...Object.keys(library),
        ...Object.keys(RUBY_EXCEPTION_PARENTS),
        ROOT_EXCEPTION,
      ],
    };
  }

  read(ref: ConstantRef): Promise<ExceptionClass> {
    const key = [ref.text, ...ref.candidates].join("\0");
    let found = this.known.get(key);
    if (found === undefined) {
      found = readException(ref, this.walking, this.library);
      this.known.set(key, found);
    }
    return found;
  }
}

/** The exception class a library or Ruby itself defines, by its full name. */
export function listedException(
  name: string,
  library: Readonly<Record<string, LibraryException>>,
): ExceptionClass | null {
  const fromLibrary = library[name];
  if (fromLibrary !== undefined) {
    return {
      name,
      ancestors: fromLibrary.ancestors,
      incomplete: false,
      inheritableByUnread: false,
    };
  }
  const fromRuby = rubyAncestors(name);
  return fromRuby === null
    ? null
    : {
        name,
        ancestors: fromRuby,
        incomplete: false,
        inheritableByUnread: true,
      };
}

/** A class the run knows nothing about beyond its name. */
export function unreadException(name: string): ExceptionClass {
  return {
    name,
    ancestors: [ROOT_EXCEPTION],
    incomplete: true,
    inheritableByUnread: true,
  };
}

/** Every class an exception is an instance of, its own first. */
export function classesOf(exception: ExceptionClass): string[] {
  return [exception.name, ...exception.ancestors];
}

/**
 * Tries each name the reference could mean, in the order Ruby looks a
 * constant up, and settles on the first one a library lists, Ruby
 * defines, or the project defines.
 */
async function readException(
  ref: ConstantRef,
  lookup: AncestorLookup,
  library: Readonly<Record<string, LibraryException>>,
): Promise<ExceptionClass> {
  for (const candidate of ref.candidates) {
    const known = listedException(candidate, library);
    if (known !== null) {
      return known;
    }

    const defined = await reachConstant([candidate], lookup);
    if (defined !== null) {
      return projectException(defined, lookup, library);
    }
  }
  return unreadException(ref.candidates.at(-1) ?? ref.text);
}

async function projectException(
  defined: NonNullable<Awaited<ReturnType<typeof reachConstant>>>,
  lookup: AncestorLookup,
  library: Readonly<Record<string, LibraryException>>,
): Promise<ExceptionClass> {
  const chain = await ancestryOf(defined.name, defined.blocks, lookup);
  const ancestors: string[] = [];
  let incomplete = false;
  for (const entry of chain) {
    if (entry.type === "bodies" && entry.name === defined.name) {
      continue;
    }
    ancestors.push(entry.name);
    if (entry.type === "root") {
      ancestors.push(
        ...(listedException(entry.name, library)?.ancestors ?? []),
      );
    }
    if (entry.type === "unfollowed") {
      incomplete = true;
    }
  }
  if (incomplete && !ancestors.includes(ROOT_EXCEPTION)) {
    ancestors.push(ROOT_EXCEPTION);
  }
  return {
    name: defined.name,
    ancestors,
    incomplete,
    inheritableByUnread: false,
  };
}

/** The ancestors of one of Ruby's own exception classes, or null for any other name. */
function rubyAncestors(name: string): string[] | null {
  if (name === ROOT_EXCEPTION) {
    return [];
  }
  if (RUBY_EXCEPTION_PARENTS[name] === undefined) {
    return null;
  }
  const ancestors: string[] = [];
  for (
    let parent = RUBY_EXCEPTION_PARENTS[name];
    parent !== undefined;
    parent = RUBY_EXCEPTION_PARENTS[parent]
  ) {
    ancestors.push(parent);
  }
  return ancestors;
}
