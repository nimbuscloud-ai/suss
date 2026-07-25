#!/usr/bin/env node
// rewriteCommitMessage.mjs — bring one commit message up to the writing
// conventions. Reads the old message on stdin, writes the new one on
// stdout, which is the shape `git filter-branch --msg-filter` wants.
//
// Two changes, both mechanical:
//
//   1. Drop the Claude-Session trailer. Those links are private to one
//      session and mean nothing to anyone reading the history.
//   2. Replace em and en dashes, which the conventions do not allow.
//
// The dash replacement is the part worth care. A blanket swap once left
// " , " with the spacing intact across the docs, so a dash ending a line
// is handled before a dash inside one, and the result is checked for the
// doubled punctuation that a careless pass produces.
//
// Nothing else is touched. Subjects, bodies, and trailers all survive
// byte for byte apart from these two rules.

/** Strip the trailer, and any blank line left stranded above it. */
function dropSessionTrailer(message) {
  return message
    .split("\n")
    .filter((line) => !/^\s*Claude-Session:/i.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\n+$/, "\n");
}

/**
 * Swap dashes for commas.
 *
 * A dash ending a line goes first, so the clause keeps its line break
 * instead of being pulled onto the previous one. Then dashes inside a
 * line, with any surrounding spaces taken with them so no gap is left
 * behind.
 */
function replaceDashes(message) {
  return (
    message
      .replace(/[ \t]*[—–][ \t]*$/gm, ",")
      .replace(/[ \t]*[—–][ \t]*/g, ", ")
      // A dash after punctuation that already separates the clause
      // leaves two marks doing one job.
      .replace(/,\s*,/g, ",")
      .replace(/:\s*,\s*/g, ": ")
      .replace(/,\s*\.\s*/g, ". ")
      .replace(/\(\s*,\s*/g, "(")
      .replace(/,\s*\)/g, ")")
  );
}

export function rewriteMessage(message) {
  return replaceDashes(dropSessionTrailer(message));
}

// Run as a filter when invoked directly.
if (process.argv[1]?.endsWith("rewriteCommitMessage.mjs")) {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  process.stdout.write(rewriteMessage(Buffer.concat(chunks).toString("utf8")));
}
