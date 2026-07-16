import { Global, Module } from "@nestjs/common";
import { REDIS_CLIENT } from "./redis.constants.js";
import { RedisConnection } from "./redis.connection.js";

@Global()
@Module({
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
