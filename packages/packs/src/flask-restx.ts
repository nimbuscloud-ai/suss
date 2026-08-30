// The pack factory, which is what `-f flask-restx` loads, and what a
// `-f flask-restx=config.json` file may say, which the CLI parses the
// file against before the factory runs.
export { default, optionsSchema } from "@suss/framework-flask-restx";
