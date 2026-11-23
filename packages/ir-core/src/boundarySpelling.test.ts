import { describe, expect, it } from "vitest";

import {
  bindingTokens,
  namesBoundary,
  namesBoundaryExactly,
  spelledInFull,
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

  it("is a store's whole label, and not an index on it", () => {
    expect(namesBoundaryExactly("aws.dynamodb:editions", editions)).toBe(true);
    expect(namesBoundaryExactly("aws.dynamodb:editions", byPublication)).toBe(
      false,
    );
    expect(namesBoundaryExactly("dynamodb:by-publication", editions)).toBe(
      false,
    );
  });

  it("reads a route's parameters by place, the way pairing does", () => {
    const deletion = restBinding({
      transport: "http",
      method: "POST",
      path: "/notes/{noteId}/delete",
      recognition: "fetch",
    });

    expect(namesBoundaryExactly("POST /notes/{id}/delete", deletion)).toBe(
      true,
    );
    expect(namesBoundaryExactly("POST /notes/:id/delete", deletion)).toBe(true);
    expect(namesBoundaryExactly("POST /delete/{id}/notes", deletion)).toBe(
      false,
    );
  });
});

describe("a route written out in full", () => {
  const notes = restBinding({
    transport: "http",
    method: "POST",
    path: "/api/notes",
    recognition: "nextjs",
  });
  const sharedNotes = restBinding({
    transport: "http",
    method: "POST",
    path: "/api/shared/notes",
    recognition: "nextjs",
  });
  const noteEdit = restBinding({
    transport: "http",
    method: "GET",
    path: "/notes/{id}/edit",
    recognition: "rails",
  });
  const note = restBinding({
    transport: "http",
    method: "GET",
    path: "/notes/:id",
    recognition: "rails",
  });

  it("is told apart from any other text", () => {
    expect(spelledInFull("POST /api/notes")).toBe(true);
    expect(spelledInFull("/api/notes")).toBe(false);
    expect(spelledInFull("aws.dynamodb:editions")).toBe(false);
  });

  it("leaves out a longer route that shares its words", () => {
    expect(namesBoundary("POST /api/notes", notes)).toBe(true);
    expect(namesBoundary("POST /api/notes", sharedNotes)).toBe(false);
    expect(namesBoundary("GET /notes/{id}", noteEdit)).toBe(false);
    expect(namesBoundary("GET /notes/{id}", note)).toBe(true);
  });

  it("leaves out another method on the same path", () => {
    expect(namesBoundary("GET /api/notes", notes)).toBe(false);
  });

  it("picks out no store, whatever words the two share", () => {
    const table = storageBinding({
      recognition: "prisma",
      storageSystem: "postgresql",
      scope: "default",
      container: "notes",
    });

    expect(namesBoundary("POST /notes", table)).toBe(false);
  });

  it("leaves a partial spelling to cover every route with its words", () => {
    expect(namesBoundary("/api/notes", notes)).toBe(true);
    expect(namesBoundary("/api/notes", sharedNotes)).toBe(true);
  });
});
