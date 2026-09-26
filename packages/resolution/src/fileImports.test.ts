import { describe, expect, it } from "vitest";

import { Database } from "@suss/datalog";

import { importedFilesByFile } from "./fileImports.js";

const shorter = (file: string): string => file.replace("/repo/", "");

describe("importedFilesByFile", () => {
  it("lists every file each file imports, both spelled the way the caller shows paths", () => {
    const db = new Database();
    db.add("importsFile", ["/repo/jobs/report.py", "/repo/models/orders.py"]);
    db.add("importsFile", ["/repo/jobs/report.py", "/repo/models/accounts.py"]);
    db.add("importsFile", ["/repo/models/orders.py", "/repo/db.py"]);

    expect(importedFilesByFile(db, shorter)).toEqual(
      new Map([
        ["jobs/report.py", ["models/orders.py", "models/accounts.py"]],
        ["models/orders.py", ["db.py"]],
      ]),
    );
  });

  it("skips a row whose columns are not both paths", () => {
    const db = new Database();
    db.add("importsFile", ["/repo/jobs/report.py", 3]);

    expect(importedFilesByFile(db, shorter)).toEqual(new Map());
  });
});
