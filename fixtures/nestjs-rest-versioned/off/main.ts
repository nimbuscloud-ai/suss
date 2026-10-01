// Nothing turns versioning on, so Nest ignores the version a
// controller states.
import { NestFactory } from "@nestjs/core";

declare const AppModule: unknown;

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  await app.listen(3000);
}

void bootstrap();
