import { describe, expect, it } from "vitest";
import {
  ApiMetricsService,
  formatMetricLabels,
  getApiMetrics,
  resetApiMetricsForTests,
} from "./api-metrics.service.js";
import { MetricsController } from "./metrics.controller.js";

describe("ApiMetricsService", () => {
  it("exposes sanitized HTTP metrics without high-cardinality route values or query credentials", () => {
    const metrics = new ApiMetricsService();

    metrics.recordHttpRequest({
      method: "GET",
      path: "/api/v1/rooms/demo-slug?roomSessionToken=secret-token",
      statusCode: 200,
      durationMs: 12,
    });

    const body = metrics.renderPrometheus();

    expect(body).toContain('api_http_requests_total{method="GET",outcome="success",route="/api/v1/rooms/:slug",status_class="2xx"} 1');
    expect(body).toContain('api_http_request_duration_seconds_count{method="GET",outcome="success",route="/api/v1/rooms/:slug",status_class="2xx"} 1');
    expect(body).not.toContain("demo-slug");
    expect(body).not.toContain("secret-token");
    expect(body).not.toContain("roomSessionToken");
  });

  it("records room-control, Redis and process metrics in Prometheus text", () => {
    resetApiMetricsForTests();
    const metrics = getApiMetrics();
    const controller = new MetricsController();

    metrics.recordRoomControl({
      operation: "join_room",
      outcome: "error",
      errorCode: "INVALID_TOKEN",
      durationMs: 3,
    });
    metrics.recordRedisOperation({
      operation: "find_room_session_by_token_hash",
      outcome: "success",
      durationMs: 1,
    });

    const body = controller.metricsText();

    expect(body).toContain('api_room_control_total{error_code="INVALID_TOKEN",operation="join_room",outcome="error"} 1');
    expect(body).toContain('api_redis_operations_total{operation="find_room_session_by_token_hash",outcome="success"} 1');
    expect(body).toContain("process_resident_memory_bytes ");
    expect(body).toContain("process_uptime_seconds ");
  });

  it("rejects forbidden high-cardinality label keys", () => {
    expect(() => formatMetricLabels({ requestId: "req_1" })).toThrow(
      "Forbidden high-cardinality metric label: requestId"
    );
    expect(() => formatMetricLabels({ request_id: "req_1" })).toThrow(
      "Forbidden high-cardinality metric label: request_id"
    );
    expect(() => formatMetricLabels({ roomId: "room_1" })).toThrow(
      "Forbidden high-cardinality metric label: roomId"
    );
    expect(() => formatMetricLabels({ participantId: "peer_1" })).toThrow(
      "Forbidden high-cardinality metric label: participantId"
    );
  });
});
