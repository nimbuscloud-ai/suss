// The pack factory, which is what `-f axios` loads, and what a
// `-f axios=config.json` file may say, which the CLI parses the
// file against before the factory runs.
export { default, optionsSchema } from "@suss/client-axios";
