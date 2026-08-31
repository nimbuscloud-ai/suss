import { describe, expect, it } from "vitest";

import {
  bindingTokens,
  namesBoundary,
  namesBoundaryExactly,
  spellingTokens,
} from "./boundarySpelling.js";
import { messageBusBinding, restBinding, storageBinding } from "./index.js";

const editions = storageBinding({
  recognition: "prisma",
  storageSystem: "aws.dynamodb",
  scope: "default",
  container: "editions",
  accessPath: null,
});

const byPublication = storageBinding({
  recognition: "prisma",
  storageSystem: "aws.dynamodb",
  scope: "default",
  container: "editions",
  accessPath: "by-publication",
});

const comments = restBinding({
  transport: "http",
  method: "POST",
  path: "/articles/{slug}/comments",
  recognition: "express",
});

describe("spellingTokens", () => {
  it("cuts the separators between parts and leaves a part alone", () => {
    expect(spellingTokens("aws.dynamodb:editions#by-publication")).toEqual([
      "aws.dynamodb",
      "editions",
      "by-publication",
    ]);
  });

  it("reads a path parameter the same however it is written", () => {
    expect(spellingTokens("GET /users/{id}")).toEqual(["get", "users", "id"]);
    expect(spellingTokens("GET /users/:id")).toEqual(["get", "users", "id"]);
  });
});

describe("bindingTokens", () => {
  it("takes the product name apart, so somebody can type dynamodb", () => {
    expect(bindingTokens(editions)).toContain("dynamodb");
    expect(bindingTokens(editions)).toContain("aws.dynamodb");
  });
});

describe("namesBoundary", () => {
  it("takes the store on its own, and every index on it", () => {
    expect(namesBoundary("aws.dynamodb:editions", editions)).toBe(true);
    expect(namesBoundary("aws.dynamodb:editions", byPublication)).toBe(true);
  });

  it("narrows to the one index when the words say which", () => {
    expect(namesBoundary("editions#by-publication", byPublication)).toBe(true);
    expect(namesBoundary("editions#by-publication", editions)).toBe(false);
  });

  it("turns down a word the boundary does not have", () => {
    expect(namesBoundary("aws.dynamodb:invoices", editions)).toBe(false);
    expect(namesBoundary("", editions)).toBe(false);
  });

  it("reads a queue the way a report writes one", () => {
    const queue = messageBusBinding({
      recognition: "aws-lambda",
      messageBus: "aws_sqs",
      channel: "billing.invoicePaid",
    });

    expect(namesBoundary("bus:aws_sqs billing.invoicePaid", queue)).toBe(true);
    expect(namesBoundary("billing.invoicePaid", queue)).toBe(true);
    expect(namesBoundary("bus:aws_sqs order.placed", queue)).toBe(false);
  });
});

describe("namesBoundaryExactly", () => {
  it("is the whole name rather than part of a longer one", () => {
    const articles = restBinding({
      transport: "http",
      method: "POST",
      path: "/articles",
      recognition: "express",
    });

    expect(namesBoundaryExactly("POST /articles", articles)).toBe(true);
    expect(namesBoundaryExactly("POST /articles", comments)).toBe(false);
    expect(namesBoundaryExactly("", articles)).toBe(false);
  });
});
