import { Global, Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { REDIS_CLIENT } from "./redis.constants.js";
import { RedisConnection } from "./redis.connection.js";

@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    RedisConnection,
    {
      provide: REDIS_CLIENT,
      inject: [RedisConnection],
      useFactory: (connection: RedisConnection) => {
        return connection.getClient();
      },
    },
  ],
  exports: [REDIS_CLIENT, RedisConnection],
})
export class RedisModule {}
