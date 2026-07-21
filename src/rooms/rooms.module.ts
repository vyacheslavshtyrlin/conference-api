import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { AuthModule } from "../auth/auth.module.js";
import { RedisRoomRepository, RoomRepository } from "./room.repository.js";
import { RoomTokenService } from "./room-token.service.js";
import { RoomsController } from "./rooms.controller.js";
import { RoomsService } from "./rooms.service.js";

@Module({
  imports: [ConfigModule, AuthModule],
  controllers: [RoomsController],
  providers: [
    RoomsService,
    RoomTokenService,
    {
      provide: RoomRepository,
      useClass: RedisRoomRepository,
    },
  ],
  exports: [RoomRepository, RoomTokenService],
})
export class RoomsModule {}
