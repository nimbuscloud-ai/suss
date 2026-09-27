// The bootstrap makes the application and hands it to a function in
// another file, which puts the global prefix in front of every route.
import { NestFactory } from "@nestjs/core";

import { configureApp } from "./configure";

declare const AppModule: unknown;

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  configureApp(app);
  await app.listen(3000);
}

void bootstrap();
