import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaClient } from "@prisma/client";
import type { ApiConfig } from "../config/api-config.js";

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor(@Inject(ConfigService) private readonly config: ConfigService<ApiConfig, true>) {
    super();
  }

  async onModuleInit(): Promise<void> {
    if (this.config.get("RECORDING_DELIVERY_ENABLED", { infer: true })) {
      await this.$connect();
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
