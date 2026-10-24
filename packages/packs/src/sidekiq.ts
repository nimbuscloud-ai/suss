// The CLI checks a `-f sidekiq=config.json` file against
// `optionsSchema` before it calls the factory.
export {
  declares,
  default,
  optionsSchema,
} from "@suss/framework-sidekiq";
