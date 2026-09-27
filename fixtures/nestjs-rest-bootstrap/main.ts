// The bootstrap sets the prefix itself and imports nothing from
// `@nestjs/common`, where the controllers' decorators come from.
import { NestFactory } from "@nestjs/core";

declare const AppModule: unknown;

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix(process.env.API_PREFIX ?? "v2");
  await app.listen(3000);
}

void bootstrap();
