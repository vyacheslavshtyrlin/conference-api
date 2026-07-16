import { CallHandler, type ExecutionContext, HttpException, Injectable, type NestInterceptor } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { catchError, tap, throwError, type Observable } from "rxjs";
import { getApiMetrics, type ApiMetricsService } from "./api-metrics.service.js";

type LogSeverity = "info" | "warn" | "error";

const stableApiErrorCodes = new Set(["ROOM_NOT_FOUND", "ROOM_EXPIRED", "ROOM_CLOSED", "INVALID_TOKEN"]);

export type ApiLogEntry = {
  timestamp: string;
  service: "api";
  severity: LogSeverity;
  operation: string;
  requestId: string;
  durationMs: number;
  statusCode: number;
  errorCode: string | null;
};

type HttpRequest = {
  method?: string;
  originalUrl?: string;
  url?: string;
  headers?: Record<string, string | string[] | undefined>;
};

type HttpResponse = {
  statusCode?: number;
  setHeader(name: string, value: string): void;
};

export type ApiLogWriter = {
  write(entry: ApiLogEntry): void;
};

export class JsonConsoleApiLogWriter implements ApiLogWriter {
  write(entry: ApiLogEntry): void {
    const line = JSON.stringify(entry);
    if (entry.severity === "error") {
      console.error(line);
      return;
    }

    console.log(line);
  }
}

function stableRequestId(candidate: string | string[] | undefined): string {
  const value = Array.isArray(candidate) ? candidate[0] : candidate;
  return value && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value) ? value : randomUUID();
}

function operationFor(request: HttpRequest): string {
  const url = request.originalUrl ?? request.url ?? "/";
  return `${request.method ?? "UNKNOWN"} ${url.split("?", 1)[0]}`;
}

function errorDetails(error: unknown): { severity: LogSeverity; statusCode: number; errorCode: string } {
  if (!(error instanceof HttpException)) {
    return { severity: "error", statusCode: 500, errorCode: "INTERNAL_ERROR" };
  }

  const statusCode = error.getStatus();
  const response = error.getResponse();
  const responseCode =
    typeof response === "object" && response !== null && "code" in response && typeof response.code === "string"
      ? response.code
      : undefined;

  if (responseCode && stableApiErrorCodes.has(responseCode)) {
    return { severity: statusCode < 500 ? "warn" : "error", statusCode, errorCode: responseCode };
  }

  if (statusCode >= 500) {
    return {
      severity: "error",
      statusCode,
      errorCode: statusCode === 500 ? "INTERNAL_ERROR" : "DEPENDENCY_UNAVAILABLE",
    };
  }

  const clientErrorCodes: Record<number, string> = {
    400: "CLIENT_INVALID_REQUEST",
    401: "CLIENT_UNAUTHORIZED",
    403: "CLIENT_FORBIDDEN",
    404: "CLIENT_NOT_FOUND",
    409: "CLIENT_CONFLICT",
    422: "CLIENT_UNPROCESSABLE",
  };

  return { severity: "warn", statusCode, errorCode: clientErrorCodes[statusCode] ?? "CLIENT_REQUEST_ERROR" };
}

@Injectable()
export class ApiLoggingInterceptor implements NestInterceptor {
  constructor(
    private readonly writer: ApiLogWriter = new JsonConsoleApiLogWriter(),
    private readonly metrics: ApiMetricsService = getApiMetrics()
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<HttpRequest>();
    const response = http.getResponse<HttpResponse>();
    const requestId = stableRequestId(request.headers?.["x-request-id"]);
    const operation = operationFor(request);
    const startedAt = performance.now();

    response.setHeader("x-request-id", requestId);

    return next.handle().pipe(
      tap(() => {
        const durationMs = performance.now() - startedAt;
        const statusCode = response.statusCode ?? 200;
        this.metrics.recordHttpRequest({
          method: request.method ?? "UNKNOWN",
          path: request.originalUrl ?? request.url ?? "/",
          statusCode,
          durationMs,
        });
        this.write({
          severity: "info",
          operation,
          requestId,
          durationMs,
          statusCode,
          errorCode: null,
        });
      }),
      catchError((error: unknown) => {
        const durationMs = performance.now() - startedAt;
        const details = errorDetails(error);
        this.metrics.recordHttpRequest({
          method: request.method ?? "UNKNOWN",
          path: request.originalUrl ?? request.url ?? "/",
          statusCode: details.statusCode,
          durationMs,
        });
        this.write({
          severity: details.severity,
          operation,
          requestId,
          durationMs,
          statusCode: details.statusCode,
          errorCode: details.errorCode,
        });
        return throwError(() => error);
      })
    );
  }

  private write(entry: Omit<ApiLogEntry, "timestamp" | "service" | "durationMs"> & { durationMs: number }): void {
    this.writer.write({
      timestamp: new Date().toISOString(),
      service: "api",
      ...entry,
      durationMs: Math.round(entry.durationMs * 100) / 100,
    });
  }
}
