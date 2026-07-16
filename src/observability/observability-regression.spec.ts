import "reflect-metadata";

import { BadRequestException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { describe, expect, it, vi } from "vitest";
import { lastValueFrom, of, throwError } from "rxjs";
import { validateApiConfig } from "../config/api-config.js";
import { ReadyController } from "../health/ready.controller.js";
import { RedisConnection } from "../redis/redis.connection.js";
import { ApiLoggingInterceptor, type ApiLogEntry, type ApiLogWriter } from "./api-logging.interceptor.js";
import { ApiMetricsService, formatMetricLabels } from "./api-metrics.service.js";

describe("E5-T6A API observability regression suite", () => {
  it("fails invalid startup configuration before serving traffic", () => {
    expect(() => validateApiConfig({ PORT: "invalid" })).toThrow("Invalid API configuration: PORT");
    expect(() => validateApiConfig({ NODE_ENV: "production" })).toThrow("JOIN_TOKEN_SECRET");
  });

  it("reflects Redis readiness loss and recovery through the stable readiness envelope", async () => {
    let redisReady = false;
    const moduleRef = await Test.createTestingModule({
      controllers: [ReadyController],
      providers: [
        {
          provide: RedisConnection,
          useValue: {
            isReady: vi.fn(async () => redisReady),
          },
        },
      ],
    }).compile();
    const controller = moduleRef.get(ReadyController);

    await expect(controller.ready()).rejects.toMatchObject({
      response: {
        status: "unavailable",
        service: "api",
        checks: { redis: "unavailable" },
      },
    });

    redisReady = true;

    await expect(controller.ready()).resolves.toEqual({
      status: "ok",
      service: "api",
      checks: { redis: "ok" },
    });
  });

  it("keeps request correlation and redacts credentials from structured request logs", async () => {
    const entries: ApiLogEntry[] = [];
    const writer: ApiLogWriter = {
      write: (entry) => entries.push(entry),
    };
    const responseHeaders = new Map<string, string>();
    const interceptor = new ApiLoggingInterceptor(writer, new ApiMetricsService());
    const context = {
      switchToHttp: () => ({
        getRequest: () => ({
          method: "POST",
          originalUrl: "/api/v1/rooms/demo-slug/join?roomSessionToken=secret-token",
          headers: {
            authorization: "Bearer secret-token",
            "x-request-id": "request-123",
          },
        }),
        getResponse: () => ({
          statusCode: 201,
          setHeader: (name: string, value: string) => responseHeaders.set(name, value),
        }),
      }),
    };

    await lastValueFrom(interceptor.intercept(context as never, { handle: () => of({ ok: true }) }));

    expect(responseHeaders.get("x-request-id")).toBe("request-123");
    expect(entries[0]).toMatchObject({
      service: "api",
      severity: "info",
      requestId: "request-123",
      statusCode: 201,
      errorCode: null,
    });
    expect(entries[0]?.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(JSON.stringify(entries[0])).not.toContain("secret-token");
    expect(JSON.stringify(entries[0])).not.toContain("authorization");
  });

  it("classifies expected client errors with stable non-secret error codes", async () => {
    const entries: ApiLogEntry[] = [];
    const interceptor = new ApiLoggingInterceptor({ write: (entry) => entries.push(entry) }, new ApiMetricsService());
    const context = {
      switchToHttp: () => ({
        getRequest: () => ({
          method: "POST",
          originalUrl: "/api/v1/rooms/demo-slug/join",
          headers: { "x-request-id": "bad-request-1" },
        }),
        getResponse: () => ({
          statusCode: 201,
          setHeader: vi.fn(),
        }),
      }),
    };

    await expect(
      lastValueFrom(
        interceptor.intercept(context as never, {
          handle: () => throwError(() => new BadRequestException({ code: "secret-token" })),
        }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(entries[0]).toMatchObject({
      service: "api",
      severity: "warn",
      requestId: "bad-request-1",
      statusCode: 400,
      errorCode: "CLIENT_INVALID_REQUEST",
    });
    expect(JSON.stringify(entries[0])).not.toContain("secret-token");
  });

  it("renders low-cardinality metrics and rejects high-cardinality label keys", () => {
    const metrics = new ApiMetricsService();

    metrics.recordHttpRequest({
      method: "GET",
      path: "/api/v1/rooms/demo-slug?roomSessionToken=secret-token",
      statusCode: 200,
      durationMs: 10,
    });
    metrics.recordRoomControl({
      operation: "join_room",
      outcome: "error",
      errorCode: "INVALID_TOKEN",
      durationMs: 5,
    });
    metrics.recordRedisOperation({
      operation: "readiness_ping",
      outcome: "error",
      durationMs: 2,
    });

    const body = metrics.renderPrometheus();

    expect(body).toContain('api_http_requests_total{method="GET",outcome="success",route="/api/v1/rooms/:slug",status_class="2xx"} 1');
    expect(body).toContain('api_room_control_total{error_code="INVALID_TOKEN",operation="join_room",outcome="error"} 1');
    expect(body).toContain('api_redis_operations_total{operation="readiness_ping",outcome="error"} 1');
    expect(body).toContain("process_resident_memory_bytes ");
    expect(body).not.toContain("demo-slug");
    expect(body).not.toContain("secret-token");
    expect(body).not.toContain("roomSessionToken");

    expect(() => formatMetricLabels({ requestId: "req_1" })).toThrow(
      "Forbidden high-cardinality metric label: requestId",
    );
    expect(() => formatMetricLabels({ commandId: "cmd_1" })).toThrow(
      "Forbidden high-cardinality metric label: commandId",
    );
    expect(() => formatMetricLabels({ roomId: "room_1" })).toThrow(
      "Forbidden high-cardinality metric label: roomId",
    );
    expect(() => formatMetricLabels({ participantId: "peer_1" })).toThrow(
      "Forbidden high-cardinality metric label: participantId",
    );
    expect(() => formatMetricLabels({ token: "secret" })).toThrow("Forbidden high-cardinality metric label: token");
  });
});
