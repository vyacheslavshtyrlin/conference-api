import { BadRequestException, ServiceUnavailableException } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { lastValueFrom, of, throwError } from "rxjs";
import { ApiLoggingInterceptor, type ApiLogEntry, type ApiLogWriter } from "./api-logging.interceptor.js";

function createHarness(options: {
  headers?: Record<string, string>;
  method?: string;
  url?: string;
  statusCode?: number;
} = {}) {
  const entries: ApiLogEntry[] = [];
  const responseHeaders = new Map<string, string>();
  const writer: ApiLogWriter = { write: (entry) => entries.push(entry) };
  const interceptor = new ApiLoggingInterceptor(writer);
  const context = {
    switchToHttp: () => ({
      getRequest: () => ({
        method: options.method ?? "POST",
        originalUrl: options.url ?? "/api/v1/rooms?roomSessionToken=secret-token",
        headers: options.headers ?? { authorization: "Bearer secret-token" },
      }),
      getResponse: () => ({
        statusCode: options.statusCode ?? 201,
        setHeader: (name: string, value: string) => responseHeaders.set(name, value),
      }),
    }),
  };

  return { context, entries, interceptor, responseHeaders };
}

describe("ApiLoggingInterceptor", () => {
  it("logs a correlated structured success entry without headers, tokens, or query credentials", async () => {
    const { context, entries, interceptor, responseHeaders } = createHarness({
      headers: { authorization: "Bearer secret-token", "x-request-id": "request-42" },
    });

    await lastValueFrom(interceptor.intercept(context as never, { handle: () => of({ ok: true }) }));

    expect(responseHeaders.get("x-request-id")).toBe("request-42");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      service: "api",
      severity: "info",
      operation: "POST /api/v1/rooms",
      requestId: "request-42",
      statusCode: 201,
      errorCode: null,
    });
    expect(entries[0]?.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(entries[0]?.durationMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(entries[0])).not.toContain("secret-token");
    expect(JSON.stringify(entries[0])).not.toContain("authorization");
  });

  it("classifies expected client errors as warnings with stable error codes", async () => {
    const { context, entries, interceptor } = createHarness();

    await expect(
      lastValueFrom(interceptor.intercept(context as never, { handle: () => throwError(() => new BadRequestException()) }))
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(entries[0]).toMatchObject({ severity: "warn", statusCode: 400, errorCode: "CLIENT_INVALID_REQUEST" });
  });

  it("does not emit arbitrary exception response codes that could contain secrets", async () => {
    const { context, entries, interceptor } = createHarness();

    await expect(
      lastValueFrom(
        interceptor.intercept(context as never, {
          handle: () => throwError(() => new BadRequestException({ code: "secret-token" })),
        })
      )
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(entries[0]).toMatchObject({ severity: "warn", statusCode: 400, errorCode: "CLIENT_INVALID_REQUEST" });
    expect(JSON.stringify(entries[0])).not.toContain("secret-token");
  });

  it("classifies dependency failures separately from client errors", async () => {
    const { context, entries, interceptor } = createHarness();

    await expect(
      lastValueFrom(
        interceptor.intercept(context as never, {
          handle: () => throwError(() => new ServiceUnavailableException()),
        })
      )
    ).rejects.toBeInstanceOf(ServiceUnavailableException);

    expect(entries[0]).toMatchObject({ severity: "error", statusCode: 503, errorCode: "DEPENDENCY_UNAVAILABLE" });
  });
});
