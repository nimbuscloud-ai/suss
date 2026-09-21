---
title: Compared to other tools
description: What a type checker, a linter, an OpenAPI validator, a contract test, an AI reviewer and grep each see, and what suss sees that they do not.
---

# Compared to other tools

suss reads each unit of code and works out what it produces on every path it can take, then compares that against the code, the specs and the deploy templates on the other side of each boundary. Most of the tools below answer a different question, and you would keep running them alongside suss.

| Tool | What it sees that suss does not | What suss sees that it does not |
|---|---|---|
| Type checkers (TypeScript, mypy, Sorbet) | Every expression in the program, and whether the types line up everywhere | Which branch produced a value, and under what condition |
| Linters and pattern matchers (ESLint, RuboCop, Semgrep, CodeQL) | Syntactic patterns anywhere in the file, including in code no entry point reaches | What one function produces, compared against what another function expects of it |
| OpenAPI and schema validators (Spectral, ajv, Zod) | Whether a document or a payload is well-formed against a schema | Whether the handler behind the document produces the responses it declares, and whether a caller reads fields it does not declare |
| Contract testing (Pact, Spring Cloud Contract) | Requests and responses that ran, including everything at run time no static reader can see | Every reachable case, including the ones nobody wrote an interaction for |
| AI review (a model reading the diff) | Naming, intent, taste, and a judgment about whether the change is a good idea | The same answer on every run, with a file and a line on both sides of each disagreement |
| grep and ripgrep | Every occurrence of a string, in any file, in any language, in milliseconds | Which of those occurrences is the one a value comes from, after imports, re-exports and factories |

## Type checkers

A type checker covers the whole program. suss does not. It reads the units a pack recognizes, plus everything reachable from them. A type checker decides whether the structure lines up: `User` is still `User` whether the account is active or soft-deleted, and `Response<200, User>` type-checks the same whichever branch of the handler built it. suss records which branch produced what and under what condition, so two 200s with different bodies come out as two cases and not one type. You run both. suss reads type information through the compiler API and never reports a type error of its own.

## Linters and pattern matchers

A linter matches syntax, such as a forbidden call or a missing `await`. CodeQL and Semgrep go further and query a whole-program database of the code, and both of them see files that no entry point reaches, which suss skips. None of them model what a function produces under what conditions, so none of them can compare one side of a call against the other. A suss finding points at one path on the provider side that disagrees with one path on the consumer side, and gives you a file and a line for each. suss has no opinions about style either, and what it produces is structured data instead of warnings.

## OpenAPI and schema validators

Spectral checks that a document is well-formed, and ajv or Zod check that a payload matches a schema at run time. Both of those are about the document. Neither one reads the handler, so both of them pass a document that declares a 500 no branch produces, and both of them pass a handler that returns a 418 the document never mentions. `suss contract --from openapi` turns the document into summaries in the same form `extract` produces, and `check` compares them against the handler and against every call site. [Check against OpenAPI](/guides/check-against-openapi) walks through that.

## Contract testing

Pact records an interaction that actually ran. The consumer states what it expects, the provider is replayed against it, and both sides execute. That catches run-time behavior no static reader can see, including serialization and middleware. What it covers is whatever somebody wrote an interaction for. suss works the cases out from the source, so a branch nobody thought to record still shows up, and it needs no test harness on either side. If you run both, you get the run-time check from Pact and the full set of cases from suss.

## AI review

A model reading a diff can judge naming, intent and whether the change was a good idea, and suss has no opinion about any of that. The model also gives you a different answer each time you ask, and it is reading the same diff the human reviewer has. suss produces the same output for the same source on every run, and every finding comes with a file and a line on both sides, so you can go and look. On a pull request you can use both: the model reasons about the change, and suss reports what the change did to every boundary it touched. [Read a pull request](/start/read-a-pull-request) sets that up, and [Give your agent suss](/start/give-your-agent-suss) gives the agent the same facts before it writes anything.

## grep

grep finds every occurrence of a string in any file in any language, faster than suss will ever load a project. To answer "what calls this" with grep, you read the hits and decide which ones matter, and that gets harder the more indirection the codebase has, such as a barrel re-export or a client built by a factory. suss follows the value through those hops and works out which function a name comes down to, and `suss ask why` prints the chain it followed, one reason per hop. [How suss follows a value](/theory/resolving-values) covers the machinery.

### Measured: raw SQL in a TypeScript monorepo

The question was "which statements does this codebase run against the database by hand", on a monorepo of several TypeScript services that use `pg` and BigQuery clients directly. With grep, the search is for `.query(` and `.execute(`.

| | grep | suss 0.32 |
|---|---|---|
| Lines returned | 90 | |
| In service code (the rest were one-off scripts, tooling and a front end) | 44 | |
| Transaction control (`BEGIN`, `COMMIT`, `ROLLBACK`) or a method named `execute` that runs no SQL | 17 | |
| SQL statements to read | 27 | 22 |

Sorting grep's 90 lines into the 27 that matter is work a person does by reading each one, and what comes out is a list of lines. suss's 22 come out as storage access on the summary of the function that runs them, each with the table, whether it reads or writes, and the fields it touches, and a route or job that reaches that function lists them too. Of the five it does not read, four run inside a method on a value whose declared type is an interface, handed in through an options object, and suss stops at the interface; the fifth goes through a client that another package in the monorepo wraps. Both are open gaps, and measurements like this one decide which gaps get fixed first.

In Ruby the same measurement is not worth publishing yet. The ActiveRecord pack reads a statement written as a string, and most raw SQL in a Rails app is a heredoc (`execute(<<~SQL)`), which it does not read at the time of writing.

### Measured: an agent answering with grep against an agent answering with suss

Two coding agents were given the same question about the suss repository itself (62 packages) and the same budget. One had grep and the file system. The other had the [MCP server](/start/give-your-agent-suss) and nothing else. The agent with suss ran on a smaller model than the agent with grep.

| Question | grep (Opus) | suss (Sonnet) |
|---|---|---|
| Which files call `@suss/datalog`'s `evaluate`? (16 files) | 15 of 16, 17 tool calls, 117s, $1.16 | 16 of 16, 1 tool call, 47s, $0.12 |
| Which exports of two adapters and the checker reach `evaluate`, through chains up to 11 calls deep? (7 exports) | 7 of 7, 34 tool calls, 216s, $1.59 | 7 of 7, 14 tool calls, 100s, $0.42 |

The first question is one hop and grep is nearly complete on it; its one miss was a file grep skipped because it contains a NUL byte. The second question is where the two separate. Each hop of a chain is another grep and another set of hits to read, so the grep agent's calls and cost grow with the depth of the chain. The suss agent asked what each package provides, asked what reaches `evaluate`, and intersected the two. Both rows were run on the same day against the same commit of suss.

## Related

- [Kinds of contract](/why/kinds-of-contract#three-kinds-of-truth) sorts specifications, observations and derivations, and explains why comparing across two of those kinds is what turns up findings.
- [The FAQ](/reference/faq) answers the shorter versions of these questions.
