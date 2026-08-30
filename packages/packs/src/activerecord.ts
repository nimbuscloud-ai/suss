// The pack factory, which is what `-f activerecord` loads, and what a
// `-f activerecord=config.json` file may say, which the CLI parses the
// file against before the factory runs.
export { default, optionsSchema } from "@suss/framework-activerecord";
