// The pack factory, which is what `-f prisma` loads, and what a
// `-f prisma=config.json` file may say, which the CLI parses the
// file against before the factory runs.
export { default, optionsSchema } from "@suss/framework-prisma";
