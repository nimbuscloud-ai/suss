import { describe, expect, it } from "vitest";

import {
  ADAPTER_VERSION,
  adapterCodeStamp,
  computeAdapterPacksDigest,
} from "./version.js";

describe("this adapter's cache stamp", () => {
  it("says source, since a vitest run has no bundle beside this module", () => {
    expect(adapterCodeStamp()).toEqual({ kind: "source" });
  });

  it("names the adapter and every pack in the digest", () => {
    expect(
      computeAdapterPacksDigest([{ name: "graphql-ruby", version: "1.0.0" }]),
    ).toBe(`adapter@${ADAPTER_VERSION}+source|graphql-ruby@1.0.0`);
  });
});
