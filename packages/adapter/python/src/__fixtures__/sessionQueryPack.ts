// A session's queries as the SQLAlchemy pack declares them, down to the
// container. The shipped pack depends on this package, so a test here
// declares the chains itself.

import { pack, storageCalls, typed } from "@suss/recognize";

import type { PythonPack } from "../pack.js";

export function sessionQueryTestPack(): PythonPack {
  const session = typed({ from: ["sqlalchemy.orm"], named: ["Session"] });
  const queries = storageCalls(
    {
      system: "postgresql",
      client: session,
      clientAt: [
        { to: "chainStart", except: ["execute"] },
        { to: "chained", fromItself: true, every: true },
      ],
      unsettledName: "nothing",
    },
    { outermost: true },
  )
    .otherwise({ kind: "read" })
    .container({
      class: { of: [{ to: "chainStart" }], at: 0 },
      notFrom: ["sqlalchemy"],
    });
  const executes = storageCalls(
    { system: "postgresql", client: session },
    { outermost: true },
  )
    .about({ to: "chainStart" })
    .methods({ execute: { kind: "nothing" } });
  const declared = pack("session-queries", [queries, executes], {
    languages: ["python"],
    recognizedAs: "python-storage",
  });
  return {
    name: "session-queries",
    protocol: "postgresql",
    discovery: [],
    invocationRecognizers: declared.invocationRecognizers ?? [],
  };
}
