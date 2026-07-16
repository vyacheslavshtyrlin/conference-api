import { ValidationPipe, type INestApplication } from "@nestjs/common";
import type { ApiConfig } from "./config/api-config.js";
import { ApiLoggingInterceptor } from "./observability/api-logging.interceptor.js";

export function configureApiApplication(app: INestApplication, config: ApiConfig): void {
  app.enableShutdownHooks();
  app.setGlobalPrefix("api/v1");
  app.enableCors({ origin: config.WEB_PUBLIC_URL });
  app.useGlobalInterceptors(new ApiLoggingInterceptor());
  app.useGlobalPipes(
    new ValidationPipe({
      forbidNonWhitelisted: true,
      transform: true,
      whitelist: true,
    })
  );
}
