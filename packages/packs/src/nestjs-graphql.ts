// The pack factory, which is what `-f nestjs-graphql` loads, and what a
// `-f nestjs-graphql=config.json` file may say, which the CLI parses the
// file against before the factory runs.
export { default, optionsSchema } from "@suss/framework-nestjs-graphql";
