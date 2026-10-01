// Header versioning leaves the path alone, so both versions of the
// invoice route share one path.
import { VersioningType } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";

declare const AppModule: unknown;

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableVersioning({ type: VersioningType.HEADER, header: "X-Version" });
  await app.listen(3000);
}

void bootstrap();
