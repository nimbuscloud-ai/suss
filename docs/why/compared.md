---
title: Compared to other tools
description: What a type checker, a linter, an OpenAPI validator, a contract test, an AI reviewer and grep each see, and what suss sees that they do not.
---

# Compared to other tools

suss reads each unit of code and works out what it produces on every path it can take, then compares that against the code, the specs and the deploy templates on the other side of each boundary. Most of the tools below answer a different question, and you would keep running them alongside it.

| Tool | What it sees that suss does not | What suss sees that it does not |
|---|---|---|
| Type checkers (TypeScript, mypy, Sorbet) | Every expression in the program, and whether the types line up everywhere | Which branch produced a value, and under what condition |
| Linters and pattern matchers (ESLint, RuboCop, Semgrep, CodeQL) | Syntactic patterns anywhere in the file, including in code no entry point reaches | What one function produces, compared against what another function expects of it |
| OpenAPI and schema validators (Spectral, ajv, Zod) | Whether a document or a payload is well-formed against a schema | Whether the handler behind the document produces the responses it declares, and whether a caller reads fields it does not declare |
| Contract testing (Pact, Spring Cloud Contract) | Requests and responses that ran, including everything at run time no static reader can see | Every reachable case, including the ones nobody wrote an interaction for |
| AI review (a model reading the diff) | Naming, intent, taste, and a judgment about whether the change is a good idea | The same answer on every run, with a file and a line on both sides of each disagreement |
| grep and ripgrep | Every occurrence of a string, in any file, in any language, in milliseconds | Which of those occurrences is the one a value comes from, after imports, re-exports and factories |

## Type checkers

A type checker covers the whole program, which suss does not: suss reads the units a pack recognizes plus everything reachable from them. What the checker settles is structure. `User` is `User` whether the account is active, soft-deleted or shadow-banned, and `Response<200, User>` type-checks the same whichever branch of the handler built it. suss records which branch produced what and under what condition, so two 200s with different bodies are two cases rather than one type. The two run together: suss reads type information through the compiler API and never reports a type error of its own.

## Linters and pattern matchers

A linter matches syntax: a forbidden call, a missing `await`, an unused variable. CodeQL and Semgrep go further and query a whole-program database of the code, and both see files that no entry point reaches, which suss skips. What none of them model is what a function produces under what conditions, so they cannot compare one side of a call against the other. A suss finding points at one path on the provider side that disagrees with one path on the consumer side, with a file and a line for each. suss also does not have style opinions; the output is structured data rather than warnings.

## OpenAPI and schema validators

Spectral tells you a document is well-formed, and ajv or Zod tells you a payload matches a schema at run time. Both are about the document. Neither reads the handler, so a document that declares a 500 no branch produces, or a handler that returns a 418 the document never mentions, passes them both. `suss contract --from openapi` turns the document into summaries in the same form `extract` produces, and `check` compares them against the handler and against every call site. [Check against OpenAPI](/guides/check-against-openapi) walks that through.

## Contract testing

Pact records an interaction that ran: the consumer states what it expects, the provider is replayed against it, and both sides execute. That catches what happens at run time and no static reader can see, serialization and middleware included. The coverage is whatever somebody wrote an interaction for. suss enumerates the cases from the source instead, so a branch nobody thought to record still shows up, and it needs no test harness on either side. A team running both gets the run-time check from Pact and the completeness from suss.

## AI review

A model reading a diff judges naming, intent and whether the change was a good idea, which suss has no opinion about. It also gives a different answer each time you ask, and it is reading the same diff the human reviewer is. suss produces the same output for the same source on every run, and each finding comes with a file and a line on both sides, so you can go and look. On a pull request the two work together: the model reasons about the change, and suss states what the change did to every boundary it touched. [Read a pull request](/start/read-a-pull-request) shows that surface, and [Give your agent suss](/start/give-your-agent-suss) hands the same facts to the agent before it writes anything.

## grep

grep finds every occurrence of a string in any file in any language, faster than suss will ever load a project. Answering "what calls this" with grep means reading the hits and deciding which ones matter, and that gets harder the more indirection the codebase has, a barrel re-export or a client built by a factory. suss follows the value through those hops and says which function a name comes down to, and `suss ask why` prints the chain it walked, one reason per hop. [How suss follows a value](/theory/resolving-values) is the machinery.

## Related

- [Kinds of contract](/why/kinds-of-contract#three-kinds-of-truth) sorts specifications, observations and derivations, and explains why a comparison across two kinds is where the findings are.
- [The FAQ](/reference/faq) answers the shorter versions of these questions.
