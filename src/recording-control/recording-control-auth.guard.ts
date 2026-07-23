import { CanActivate, ExecutionContext, Inject, Injectable } from "@nestjs/common";
import { RecordingControlAuthService } from "./recording-control-auth.service.js";

@Injectable()
export class RecordingControlAuthGuard implements CanActivate {
  constructor(@Inject(RecordingControlAuthService) private readonly auth: RecordingControlAuthService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{ headers?: { authorization?: string | string[] } }>();
    this.auth.verifyBearerHeader(request.headers?.authorization);
    return true;
  }
}
