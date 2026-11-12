// A schema built in one file from a default import of zod, parsed in another.
import zod from "zod";

export const AppEnv = zod.object({
  APP_DATABASE_URL: zod.string(),
  APP_LOG_LEVEL: zod.string().default("info"),
});
