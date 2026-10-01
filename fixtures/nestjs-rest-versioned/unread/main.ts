// The versioning type comes from a parameter, so the run cannot tell
// whether the version is in the path.
import { NestFactory } from "@nestjs/core";

import type { VersioningType } from "@nestjs/common";

declare const AppModule: unknown;

export async function bootstrap(type: VersioningType.URI | VersioningType.HEADER) {
  const app = await NestFactory.create(AppModule);
  app.enableVersioning({ type });
  await app.listen(3000);
}
