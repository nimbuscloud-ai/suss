// The pack factory, which is what `-f hono` loads, and what a
// `-f hono=config.json` file may say, which the CLI parses the
// file against before the factory runs.
export { default, optionsSchema } from "@suss/framework-hono";
