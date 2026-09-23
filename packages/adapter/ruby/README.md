# @suss/adapter-ruby

Read a Ruby codebase with [suss](https://github.com/nimbuscloud-ai/suss).

suss reads both sides of every call in a repository and reports where the two disagree. A client might ask for a field the route stopped returning, a status might go unhandled, or a queue might have no consumer. It reads the code itself, without a model or network access. This package reads Ruby. It parses with tree-sitter, resolves a constant the way Ruby does, and records what each Rails action and each graphql-ruby field returns.

## Install

```bash
npm install --save-dev @suss/cli
```

The adapter ships inside the CLI, so there is nothing else to install.

## Read a Rails app

```bash
npx suss extract --lang ruby -f rails -f activerecord -o summaries/ruby.json
npx suss check --dir summaries/
```

`suss init` reads your Gemfile and writes those two commands out for your own project.

## What it reads

- Rails controller actions, bound to the method and path that `config/routes.rb` gives each one. It records every status an action can respond with, and the `before_action` filters that run before it.
- graphql-ruby's class-based field DSL, including `mutation:` and `resolver:` wiring. It finds the method behind a field wherever the class's ancestry defines it.
- ActiveRecord calls, what a file reads from the environment, and what a body calls out to. These are recorded as facts that the checker's rules run over.
- SQL a project wrote itself and passed to a database client. `@suss/sql` parses it into the tables it touches.

How each of those is decided, and where it stops: [how the Ruby adapter reads a project](./DESIGN.md).

## Reading a value

Code outside the facility never reads a node's text to find out what a value is. `values/evaluator.ts` is the evaluator. `evaluatedValue` runs the statements ahead of an expression and returns what it comes to. `stringValueOf` returns the string when the value settles to one, so a path built by interpolation or out of a constant reads the same as one written out. `facts/resolve.ts` works out where a name came from, with `writtenValueOf` and `resolvedFunctions`. The literal readers in `ast.ts` (`stringLiteralValue`, `symbolValue`, `booleanLiteralValue`) are for the places where a literal is written out in the source. When one of them cannot read a spelling, add the case to the evaluator's lowering or to the resolution rules. `npm run check:readers` at the repo root fails on a reader written beside a call site instead. [`design/docs-internal/style.md#reading-a-value`](../../../design/docs-internal/style.md#reading-a-value) has the rule.

## Where it fits

It depends on `@suss/extractor`, `@suss/behavioral-ir`, `@suss/datalog` and `web-tree-sitter`. The `rails` and `graphql-ruby` packs consume its `RubyPack` contract. Nothing in this package hardcodes what a particular library's classes or base classes are called. The packs declare those.

`grammar/tree-sitter-ruby.wasm` is a checked-in binary, and the build does not produce it. [Where it comes from](./grammar/README.md).

## More

- [Documentation](https://suss.sh/)
- [Python and Ruby](https://suss.sh/guides/python-and-ruby)
- [Every pack suss ships](https://suss.sh/packs/catalog)
- [Source and issues](https://github.com/nimbuscloud-ai/suss)

![coverage](../../../.github/badges/coverage-ruby.svg)

Apache 2.0. See [LICENSE](../../../LICENSE).
