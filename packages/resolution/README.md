# @suss/resolution

Part of [suss](https://github.com/nimbuscloud-ai/suss), which reads both sides of every call in a repository and says where the two disagree.

The rules for following a value to the function it ends up being.

## What this package is

Datalog rules, and the few decisions that need source order rather than
a fixpoint. It has no parser, no language, and no files of its own. An
adapter reads source into facts, adds its own rules onto these, and
evaluates the whole set on `@suss/datalog`.

The rules are about programming languages in general rather than about
any one of them. A name binds to a value. A call puts an argument in a
parameter. A module exports a name, and another module can forward it.
A function that returns a function calling its parameter hands back the
argument it was given, which is a decorator in Python, a closure in Go,
and a handler factory in TypeScript.

## More

- [How the rules follow a value](./DESIGN.md)
- [Documentation](https://nimbuscloud-ai.github.io/suss/)
- [Source and issues](https://github.com/nimbuscloud-ai/suss)

![coverage](../../.github/badges/coverage-resolution.svg)

Apache 2.0. See [LICENSE](../../LICENSE).
