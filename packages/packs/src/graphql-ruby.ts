// The CLI checks a `-f graphql-ruby=config.json` file against
// `optionsSchema` before it calls the factory. `suss infer stub` reads
// the root class list to skip a class that extends the library directly.
export {
  declares,
  default,
  GRAPHQL_RUBY_ROOT_CLASS_NAMES,
  optionsSchema,
} from "@suss/framework-graphql-ruby";
