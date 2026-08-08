import { describe, expect, it } from "vitest";

import {
  namesDocumentByFileName,
  nestedDocumentLabel,
  parseDocumentLabel,
  rootDocumentLabel,
} from "./routing.js";

describe("document labels", () => {
  it("keeps a root document's label as it is", () => {
    expect(nestedDocumentLabel("cloudformation:root.yaml", [])).toBe(
      "cloudformation:root.yaml",
    );
    expect(rootDocumentLabel("cloudformation:root.yaml")).toBe(
      "cloudformation:root.yaml",
    );
  });

  it("round-trips a nested document back to its root", () => {
    const label = nestedDocumentLabel("cloudformation:root.yaml", [
      "OrdersStack",
      "InnerStack",
    ]);

    expect(label).toBe("cloudformation:root.yaml#OrdersStack/InnerStack");
    expect(rootDocumentLabel(label)).toBe("cloudformation:root.yaml");
  });

  it("gives two documents of one tree the same root and two trees different roots", () => {
    const childA = nestedDocumentLabel("a.yaml", ["StackA"]);
    const childB = nestedDocumentLabel("a.yaml", ["StackB"]);

    expect(rootDocumentLabel(childA)).toBe(rootDocumentLabel(childB));
    expect(rootDocumentLabel(childA)).not.toBe(rootDocumentLabel("b.yaml"));
  });

  it("reads a label back as the reader that wrote it and where the document sits", () => {
    expect(
      parseDocumentLabel("cloudformation:services/a/template.yaml"),
    ).toEqual({
      reader: "cloudformation",
      location: "services/a/template.yaml",
    });
  });

  it("reads nothing back from a summary ref naming a function in source", () => {
    expect(parseDocumentLabel("src/handlers/pet.ts::getPet")).toBeNull();
    expect(parseDocumentLabel("src/handlers/pet.ts")).toBeNull();
  });

  it("says which labels name a document by file name alone", () => {
    expect(namesDocumentByFileName("cloudformation:template.yaml")).toBe(true);
    expect(namesDocumentByFileName("cloudformation:a/template.yaml")).toBe(
      false,
    );
    expect(namesDocumentByFileName("src/handlers/pet.ts")).toBe(false);
  });
});
