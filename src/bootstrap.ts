import { RequestMethod, ValidationPipe, type INestApplication } from "@nestjs/common";
import type { ApiConfig } from "./config/api-config.js";
import { ApiLoggingInterceptor } from "./observability/api-logging.interceptor.js";
import { configureSwaggerDocumentation } from "./swagger.js";

export function configureApiApplication(app: INestApplication, config: ApiConfig): void {
  app.enableShutdownHooks();
  app.setGlobalPrefix("api/v1", {
    exclude: [
      { path: "api/integrations/v1/rooms", method: RequestMethod.ALL },
      { path: "api/integrations/v1/rooms/(.*)", method: RequestMethod.ALL },
      { path: "api/integrations/v1/recordings/(.*)", method: RequestMethod.ALL },
      { path: "internal/v1/rooms/(.*)", method: RequestMethod.ALL },
      { path: "internal/v1/recordings/(.*)", method: RequestMethod.ALL },
      { path: "internal/v1/composition-jobs/(.*)", method: RequestMethod.ALL },
      { path: "internal/v1/room-history/(.*)", method: RequestMethod.ALL },
    ],
  });
  app.enableCors({ credentials: true, origin: config.WEB_PUBLIC_URL });
  app.useGlobalInterceptors(new ApiLoggingInterceptor());
  app.useGlobalPipes(
    new ValidationPipe({
      forbidNonWhitelisted: true,
      transform: true,
      whitelist: true,
    })
  );
  configureSwaggerDocumentation(app);
}
