// The pack factory, which is what `-f graphql-ruby` loads, and the options
// schema. The CLI checks a `-f graphql-ruby=config.json` file against that
// schema minus the keys a dependency stub fills.
export { default, optionsSchema } from "@suss/framework-graphql-ruby";
