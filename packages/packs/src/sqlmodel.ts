// The pack factory, which is what `-f sqlmodel` loads, and what a
// `-f sqlmodel=config.json` file may say, which the CLI parses the
// file against before the factory runs.
export { declares, default, optionsSchema } from "@suss/framework-sqlmodel";
