/**
 * packWords.ts: the facts a pack states about its own library.
 *
 * Nothing in a source file says that `Account.find(id)` gives back one
 * Account, or that entering `httpx.Client()` gives back the client it
 * built. The library knows, the pack writes it down, and an adapter puts
 * it in the store. Every adapter did that with a loop of its own, so
 * each new word had to be written three times. `addPackWords` is the one
 * loop; an adapter maps its own pack type onto `PackWords` and calls it.
 *
 * Each field has the name of the relation it adds, as DESIGN.md lists it.
 */

import type { Database } from "@suss/datalog";

/** A method on a class reaching `base` gives back one of that class. */
export interface GivesBackOne {
  base: string;
  method: string;
}

/** The same, for a library that takes the class at position `argument` instead of as the receiver. */
export interface GivesBackOneOfArgument extends GivesBackOne {
  argument: number;
}

/** The same again, for the bare function `module` exports under `name`. */
export interface GivesBackOneOfImport {
  module: string;
  name: string;
  argument: number;
}

/** Entering one of `module`'s `name` gives back that same object. */
export interface EntersAsSelf {
  module: string;
  name: string;
}

/** Calling the `name` that `module` exports gives back its argument at `argument`. */
export interface UnwrapsByName {
  module: string;
  name: string;
  argument: number;
}

/** A field given a call of `module`'s `name` declares an association. */
export interface AssociationConstructor {
  module: string;
  name: string;
}

/** What a run's packs say about their own libraries, in one language-neutral shape. */
export interface PackWords {
  givesBackOne?: ReadonlyArray<GivesBackOne>;
  givesBackOneOfArgument?: ReadonlyArray<GivesBackOneOfArgument>;
  givesBackOneOfImport?: ReadonlyArray<GivesBackOneOfImport>;
  entersAsSelf?: ReadonlyArray<EntersAsSelf>;
  unwrapsByName?: ReadonlyArray<UnwrapsByName>;
  associationConstructor?: ReadonlyArray<AssociationConstructor>;
  /** Methods that hand back the object they are called on, by name. */
  returnsReceiver?: ReadonlyArray<string>;
}

/** Put a run's pack declarations in the store, so the shared rules can read them. */
export function addPackWords(db: Database, words: PackWords): void {
  for (const word of words.givesBackOne ?? []) {
    db.add("givesBackOne", [word.base, word.method]);
  }
  for (const word of words.givesBackOneOfArgument ?? []) {
    db.add("givesBackOneOfArgument", [
      word.base,
      word.method,
      String(word.argument),
    ]);
  }
  for (const word of words.givesBackOneOfImport ?? []) {
    db.add("givesBackOneOfImport", [
      word.module,
      word.name,
      String(word.argument),
    ]);
  }
  for (const word of words.entersAsSelf ?? []) {
    db.add("entersAsSelf", [word.module, word.name]);
  }
  for (const word of words.unwrapsByName ?? []) {
    db.add("unwrapsByName", [word.module, word.name, String(word.argument)]);
  }
  for (const word of words.associationConstructor ?? []) {
    db.add("associationConstructor", [word.module, word.name]);
  }
  for (const method of words.returnsReceiver ?? []) {
    db.add("returnsReceiver", [method]);
  }
}
