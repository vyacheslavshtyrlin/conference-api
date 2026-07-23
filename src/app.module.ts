import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { AppConfigModule } from "./app-config/app-config.module.js";
import { HealthModule } from "./health/health.module.js";
import { IntegrationsModule } from "./integrations/integrations.module.js";
import { RedisModule } from "./redis/redis.module.js";
import { RoomsModule } from "./rooms/rooms.module.js";
import { RecordingControlModule } from "./recording-control/recording-control.module.js";
import { PrismaModule } from "./prisma/prisma.module.js";
import { RecordingsModule } from "./recordings/recordings.module.js";
import { validateApiConfig } from "./config/api-config.js";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateApiConfig,
    }),
    AppConfigModule,
    PrismaModule,
    RecordingsModule,
    IntegrationsModule,
    RedisModule,
    HealthModule,
    RoomsModule,
    RecordingControlModule,
  ],
})
export class AppModule {}
