// The pack factory, which is what `-f sqlalchemy` loads, and what a
// `-f sqlalchemy=config.json` file may say, which the CLI parses the
// file against before the factory runs.
export { default, optionsSchema } from "@suss/framework-sqlalchemy";
