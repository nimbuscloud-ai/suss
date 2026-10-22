// The CLI checks a `-f activerecord=config.json` file against
// `optionsSchema` before it calls the factory. `contract --from
// rails-schema` reads the engine through `storageSystemFromDatabaseYml`.
export {
  declares,
  default,
  optionsSchema,
  storageSystemFromDatabaseYml,
} from "@suss/framework-activerecord";
