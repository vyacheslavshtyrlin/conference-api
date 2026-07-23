import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { timingSafeEqual } from "node:crypto";
import type { ApiConfig } from "../config/api-config.js";

@Injectable()
export class RecordingWorkerAuthGuard implements CanActivate {
  constructor(@Inject(ConfigService) private readonly config: ConfigService<ApiConfig, true>) {}

  canActivate(context: ExecutionContext): boolean {
    const authorization = context.switchToHttp().getRequest<{ headers: Record<string, string | undefined> }>().headers.authorization;
    const expected = this.config.get("RECORDING_CAPTURE_SERVICE_SECRET", { infer: true });
    if (!expected || !authorization?.startsWith("Bearer ") || !equal(authorization.slice(7), expected)) {
      throw new UnauthorizedException();
    }
    return true;
  }
}

@Injectable()
export class CompositionWorkerAuthGuard implements CanActivate {
  constructor(@Inject(ConfigService) private readonly config: ConfigService<ApiConfig, true>) {}

  canActivate(context: ExecutionContext): boolean {
    const authorization = context.switchToHttp().getRequest<{ headers: Record<string, string | undefined> }>().headers.authorization;
    const expected = this.config.get("RECORDING_COMPOSITION_SERVICE_SECRET", { infer: true });
    if (!expected || !authorization?.startsWith("Bearer ") || !equal(authorization.slice(7), expected)) {
      throw new UnauthorizedException();
    }
    return true;
  }
}

function equal(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
