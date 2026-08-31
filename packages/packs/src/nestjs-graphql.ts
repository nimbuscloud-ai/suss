// The pack factory, which is what `-f nestjs-graphql` loads, and the options
// schema. The CLI checks a `-f nestjs-graphql=config.json` file against that
// schema minus the keys a dependency stub fills.
export { default, optionsSchema } from "@suss/framework-nestjs-graphql";
