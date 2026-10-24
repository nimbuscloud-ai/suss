/**
 * The git repository an extract ran in, as each summary records it under
 * `location.repository`. The name is the repository's folder, the remote
 * is `origin` with any credentials left out, and the commit is HEAD.
 */

import fs from "node:fs";
import path from "node:path";

import { git, repositoryOf } from "./checkBase.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

export type RepositoryRecord = NonNullable<
  BehavioralSummary["location"]["repository"]
>;

/** The repository `projectRoot` is in, or null outside one. */
export function repositoryRecord(projectRoot: string): RepositoryRecord | null {
  const top = repositoryOf(projectRoot);
  if (top === null) {
    return null;
  }
  const remote = git(top, ["remote", "get-url", "origin"])?.trim();
  const commit = git(top, ["rev-parse", "HEAD"])?.trim();
  const relative = path
    .relative(top, safeRealPath(projectRoot))
    .split(path.sep)
    .join("/");
  return {
    name: path.basename(top),
    path: relative,
    ...(remote === undefined || remote === ""
      ? {}
      : { remote: withoutCredentials(remote) }),
    ...(commit === undefined || commit === "" ? {} : { commit }),
  };
}

/** Stamps every summary with the repository, when there is one. */
export function stampRepository(
  summaries: readonly BehavioralSummary[],
  record: RepositoryRecord | null,
): void {
  if (record === null) {
    return;
  }
  for (const summary of summaries) {
    summary.location.repository = record;
  }
}

/** `https://user:token@host/x` keeps the host and path, so a token never lands in a summary. */
function withoutCredentials(remote: string): string {
  return remote.replace(/^(\w+:\/\/)[^@/]+@/, "$1");
}

function safeRealPath(dir: string): string {
  try {
    return fs.realpathSync(path.resolve(dir));
  } catch {
    return path.resolve(dir);
  }
}
