/**
 * What a Rails app's own configuration hands to code suss does not read.
 * `Bundler.require` in `config/application.rb` loads every gem in the
 * Gemfile, and each gem's railtie can add routes, or middleware that
 * responds to a request itself. Middleware the project adds through
 * `config.middleware` can respond to any request as well. suss reads
 * neither, so each covers every path, and a missing-route check leaves
 * the service out. A list of the gems that do neither is what would let
 * such a service be checked again.
 */

import fs from "node:fs";
import path from "node:path";

import { moduleOpsForFile } from "@suss/adapter-ruby";
import { spelled } from "@suss/recognize";

import type { ServedBesideEntry } from "@suss/behavioral-ir";
import type { CallOps } from "@suss/extractor";

/** The `config.middleware` methods that add a middleware or put one in another's place. */
const MIDDLEWARE_CHANGES = new Set([
  "use",
  "insert_before",
  "insert_after",
  "swap",
]);

const BUNDLER = spelled("Bundler");

/** Each file under `config/` that hands the app to code suss does not read, once for each way it does, covering every path. */
export function configuredBeside(
  railsRoot: string,
  displayPathOf: (file: string) => string,
): ServedBesideEntry[] {
  const config = path.join(railsRoot, "config");
  const application = path.join(config, "application.rb");
  return rubyFilesUnder(config).flatMap((file) => {
    const written = moduleOpsForFile(file)
      .calls("file")
      .flatMap((call) => writtenFor(call, file === application));
    return [...new Set(written)].map((one) => ({
      by: "unread" as const,
      file: displayPathOf(file),
      line: 1,
      written: one,
    }));
  });
}

/** What an entry says of the call, or nothing for a call that hands nothing on. */
function writtenFor(call: CallOps, inApplication: boolean): string[] {
  if (
    inApplication &&
    call.method() === "require" &&
    call.receiverIsFrom(BUNDLER)
  ) {
    return ["Bundler.require: gems loaded here can add routes and middleware"];
  }
  if (
    MIDDLEWARE_CHANGES.has(call.method() ?? "") &&
    call.receiver()?.method() === "middleware"
  ) {
    return [`${call.calleeText()}: middleware suss does not read`];
  }
  return [];
}

function rubyFilesUnder(directory: string): string[] {
  if (!fs.existsSync(directory)) {
    return [];
  }
  return fs
    .readdirSync(directory, { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".rb"))
    .map((name) => path.join(directory, name))
    .sort();
}
