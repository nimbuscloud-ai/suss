import { describe, expect, it } from "vitest";

import { jsonAttributeValue } from "./jsonAttribute.js";

describe("an attribute whose value is JSON", () => {
  it("reads a literal, which is how a heredoc arrives", () => {
    expect(
      jsonAttributeValue('[{ "name": "order_id", "type": "STRING" }]'),
    ).toEqual([{ name: "order_id", type: "STRING" }]);
  });

  it("reads the HCL value jsonencode was given", () => {
    expect(
      jsonAttributeValue(
        '${jsonencode([\n  { name = "order_id", type = "STRING" },\n])}',
      ),
    ).toEqual([{ name: "order_id", type: "STRING" }]);
  });

  it("reads a nested list inside jsonencode, as a task definition writes one", () => {
    expect(
      jsonAttributeValue(
        '${jsonencode([{ name = "api", environment = [{ name = "PORT", value = "8080" }] }])}',
      ),
    ).toEqual([
      { name: "api", environment: [{ name: "PORT", value: "8080" }] },
    ]);
  });

  it("keeps the hole in a value the deploy fills in", () => {
    expect(jsonAttributeValue("${jsonencode([{ name = var.field }])}")).toEqual(
      [{ name: "${var.field}" }],
    );
  });

  it("says nothing about a value a file supplies", () => {
    expect(jsonAttributeValue('${file("schema/orders.json")}')).toBeNull();
  });

  it("says nothing about a value a variable supplies whole", () => {
    expect(jsonAttributeValue("${var.schema}")).toBeNull();
  });

  it("says nothing about an attribute the configuration never set", () => {
    expect(jsonAttributeValue(undefined)).toBeNull();
  });

  it("says nothing about text that is neither JSON nor jsonencode", () => {
    expect(jsonAttributeValue("orders")).toBeNull();
  });

  it("says nothing about a jsonencode argument the parser cannot read", () => {
    expect(jsonAttributeValue("${jsonencode([{ name = }])}")).toBeNull();
  });
});
