// The pack factory, which is what `-f graphql-ruby` loads, and what a
// `-f graphql-ruby=config.json` file may say, which the CLI parses the
// file against before the factory runs.
export { default, optionsSchema } from "@suss/framework-graphql-ruby";
