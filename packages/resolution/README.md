# @suss/resolution

Part of [suss](https://github.com/nimbuscloud-ai/suss), which reads both sides of every call in a repository and says where the two disagree.

These rules follow a value to the function it ends up being.

## What this package is

The package is a set of Datalog rules, plus the few decisions that
depend on source order and so cannot come out of a fixpoint. It does not
parse anything or read files. An adapter reads source into facts, adds
its own rules to these, and evaluates the whole set on `@suss/datalog`.

The rules cover what programming languages have in common, so none of
them is specific to one language. A name binds to a value. A call puts
an argument in a parameter. A module exports a name, and another module
can forward it. A function that returns a function calling its
parameter gives back the argument it was passed. Python calls that a
decorator, Go a closure, and TypeScript a handler factory.

## More

- [How the rules follow a value](./DESIGN.md)
- [Documentation](https://suss.sh/)
- [Source and issues](https://github.com/nimbuscloud-ai/suss)

![coverage](../../.github/badges/coverage-resolution.svg)

Apache 2.0. See [LICENSE](../../LICENSE).
