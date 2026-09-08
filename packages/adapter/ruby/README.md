# @suss/adapter-ruby

Read a Ruby codebase with [suss](https://github.com/nimbuscloud-ai/suss).

suss reads both sides of every call in a repository and says where the two disagree: a client asking for a field the route stopped returning, a status nobody handles, a queue with no consumer. It reads the code itself, with no model and no network. This package is the part that reads Ruby: it parses with tree-sitter, resolves a constant the way Ruby does, and writes down what each Rails action and each graphql-ruby field returns.

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

- Rails controller actions, bound to the method and path `config/routes.rb` gives each one, with every status an action can respond with and the `before_action` filters that run in front of it.
- graphql-ruby's class-based field DSL, including `mutation:` and `resolver:` wiring, and the method behind a field wherever it is defined in the class's ancestry.
- ActiveRecord calls, what a file reads from the environment, and what a body calls out to, as facts the checker's rules run over.

How each of those is decided, and where it stops: [how the Ruby adapter reads a project](./DESIGN.md).

## Where it fits

It depends on `@suss/extractor`, `@suss/behavioral-ir`, `@suss/datalog` and `web-tree-sitter`. The `rails` and `graphql-ruby` packs consume its `RubyPack` contract. Nothing here knows what any particular library's classes or base classes are called; a pack says that.

`grammar/tree-sitter-ruby.wasm` is a checked-in binary, not a build output. [Where it comes from](./grammar/README.md).

## More

- [Documentation](https://nimbuscloud-ai.github.io/suss/)
- [Python and Ruby](https://nimbuscloud-ai.github.io/suss/guides/python-and-ruby)
- [Every pack suss ships](https://nimbuscloud-ai.github.io/suss/reference/packages)
- [Source and issues](https://github.com/nimbuscloud-ai/suss)

![coverage](../../../.github/badges/coverage-ruby.svg)

Apache 2.0. See [LICENSE](../../../LICENSE).
