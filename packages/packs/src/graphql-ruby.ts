// The pack factory, which is what `-f graphql-ruby` loads, and the options
// schema. The CLI checks a `-f graphql-ruby=config.json` file against that
// schema minus the keys a dependency stub fills. The root class list is
// what `suss infer stub` reads to skip a class that extends the library
// directly.
export {
  default,
  GRAPHQL_RUBY_ROOT_CLASS_NAMES,
  optionsSchema,
} from "@suss/framework-graphql-ruby";
