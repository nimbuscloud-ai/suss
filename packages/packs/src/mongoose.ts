// The pack factory, which is what `-f mongoose` loads, and what a
// `-f mongoose=config.json` file may say, which the CLI parses the
// file against before the factory runs.
export { default, optionsSchema } from "@suss/framework-mongoose";
