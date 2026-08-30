// The pack factory, which is what `-f fastify` loads, and what a
// `-f fastify=config.json` file may say, which the CLI parses the
// file against before the factory runs.
export { default, optionsSchema } from "@suss/framework-fastify";
