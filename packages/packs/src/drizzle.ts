// The pack factory, which is what `-f drizzle` loads, and what a
// `-f drizzle=config.json` file may say, which the CLI parses the
// file against before the factory runs.
export { default, optionsSchema } from "@suss/framework-drizzle";
