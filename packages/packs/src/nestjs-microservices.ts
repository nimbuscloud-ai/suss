// The pack factory, which is what `-f nestjs-microservices` loads, and what a
// `-f nestjs-microservices=config.json` file may say, which the CLI parses the
// file against before the factory runs.
export { default, optionsSchema } from "@suss/framework-nestjs-microservices";
