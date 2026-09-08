/**
 * What a pack says about itself, for everything that has to know a pack
 * exists without reading its patterns.
 *
 * `suss init` suggests a pack when it sees the library in a project's
 * manifest, and the packages page lists every pack with a line about
 * what it reads. Both used to be tables somebody edited by hand, in the
 * CLI and in a document, and both went stale the release after a pack
 * arrived. A pack states this beside its own patterns instead.
 */

/** The manifest a dependency is declared in. */
export type Ecosystem = "npm" | "pypi" | "rubygems";

/**
 * A value a pack cannot work out from the code, which the project has
 * to write down before the pack reads anything: which directory the
 * classes are under, which file the routes are in.
 */
export interface PackConfiguration {
  /** Where to write it, relative to the project. */
  file: string;
  /** A starting point, with this project's own values to fill in. */
  example: Record<string, unknown>;
  /** Whether the pack refuses to run without it. */
  required: boolean;
  /** What the value is, in a sentence. */
  why: string;
}

export interface PackDeclaration {
  /**
   * What the pack contributes. A `framework` pack discovers units, a
   * `client` pack binds a call to the route it reaches, and an
   * `effects` pack recognises calls inside units another pack found, so
   * on its own it comes back empty.
   */
  kind: "framework" | "client" | "effects";
  /** The npm package that ships the pack, which a project installs. */
  package: string;
  /**
   * What a project has to depend on for this pack to read anything.
   * Several entries mean any one of them, the way react-router ships
   * under two names.
   */
  dependencies: Array<{ ecosystem: Ecosystem; name: string }>;
  /**
   * Set for a library the language itself ships, which no manifest
   * lists: Ruby's Net::HTTP, the browser's fetch, Node's own surface.
   * Every project in that language is a candidate.
   */
  shippedWith?: "typescript" | "python" | "ruby";
  /** The line the packages page shows, one sentence, what it reads. */
  reads: string;
  /** Set when the pack needs a value from the project to run at all. */
  configuration?: PackConfiguration;
}
