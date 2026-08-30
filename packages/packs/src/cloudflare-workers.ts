// The pack factory, which is what `-f cloudflare-workers` loads, and what a
// `-f cloudflare-workers=config.json` file may say, which the CLI parses the
// file against before the factory runs.
export { default, optionsSchema } from "@suss/framework-cloudflare-workers";
