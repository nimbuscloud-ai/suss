import { describe, expect, it } from "vitest";

import { ADAPTER_VERSION, adapterStamp } from "./version.js";

describe("this adapter's cache stamp", () => {
  it("says source, since a vitest run has no bundle beside this module", () => {
    expect(adapterStamp.codeStamp()).toEqual({ kind: "source" });
  });

  it("names the adapter and every pack in the digest", () => {
    expect(
      adapterStamp.packsDigest([{ name: "fastapi", version: "1.0.0" }]),
    ).toBe(`adapter@${ADAPTER_VERSION}+source|fastapi@1.0.0`);
  });
});
