// SQLAlchemy's `text(sql)` as the SQLAlchemy pack declares it, for a test
// that reads a statement a project wrote itself. The shipped pack depends
// on this package, so a test here declares the same chain.

import { imported, pack, sqlStatements } from "@suss/recognize";

import type { PythonPack } from "../pack.js";

export function sqlTextTestPack(
  storageSystem: "postgresql" | "mysql" | "sqlite",
): PythonPack {
  const statements = sqlStatements({
    system: storageSystem,
    dialect: storageSystem,
    client: imported({ from: ["sqlalchemy"], named: ["text"] }),
  }).calls({
    statement: { at: 0 },
    parameters: [
      { of: [{ to: "chained", method: "bindparams" }], keywords: true },
      { of: [{ to: "passedTo", at: 0 }], at: 1, keyword: "params" },
      {
        of: [
          { to: "chained", method: "bindparams" },
          { to: "passedTo", at: 0 },
        ],
        at: 1,
        keyword: "params",
      },
    ],
  });
  const declared = pack("sqlalchemy-text", [statements], {
    languages: ["python"],
    recognizedAs: "python-sqlalchemy",
  });
  return {
    name: "sqlalchemy-text",
    protocol: storageSystem,
    discovery: [],
    invocationRecognizers: declared.invocationRecognizers ?? [],
    accessRecognizers: declared.accessRecognizers ?? [],
  };
}
