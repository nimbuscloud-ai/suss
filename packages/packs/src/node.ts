// The pack factory, which is what `-f node` loads, and what a
// `-f node=config.json` file may say, which the CLI parses the
// file against before the factory runs.
export { default, optionsSchema } from "@suss/runtime-node";
