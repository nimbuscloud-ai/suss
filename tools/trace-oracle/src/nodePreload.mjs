/**
 * Loads OpenTelemetry's Node auto-instrumentation into the process that
 * imports it, `node --import <this file>`, from the directory given in
 * TRACE_ORACLE_OTEL, so the app under test needs no new dependency.
 * An ESM app needs the loader hook as well, since a library it imports
 * never passes through require, where the CommonJS hook waits.
 */

import { createRequire, register } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const directory = process.env.TRACE_ORACLE_OTEL;
if (directory === undefined || directory === "") {
  throw new Error(
    "set TRACE_ORACLE_OTEL to a directory where @opentelemetry/auto-instrumentations-node is installed",
  );
}
const require = createRequire(path.join(directory, "package.json"));
register(
  pathToFileURL(require.resolve("@opentelemetry/instrumentation/hook.mjs")),
);
require("@opentelemetry/auto-instrumentations-node/register");
