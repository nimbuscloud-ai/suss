// The pack factory, which is what `-f express` loads, and what a
// `-f express=config.json` file may say, which the CLI parses the
// file against before the factory runs.
export { default, optionsSchema } from "@suss/framework-express";
