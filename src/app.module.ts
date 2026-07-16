import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { HealthModule } from "./health/health.module.js";
import { RedisModule } from "./redis/redis.module.js";
import { RoomsModule } from "./rooms/rooms.module.js";
import { validateApiConfig } from "./config/api-config.js";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateApiConfig,
    }),
    RedisModule,
    HealthModule,
    RoomsModule,
  ],
})
export class AppModule {}
