// The pack factory, which is what `-f fastapi` loads, and what a
// `-f fastapi=config.json` file may say, which the CLI parses the
// file against before the factory runs.
export { default, optionsSchema } from "@suss/framework-fastapi";
