import { Injectable } from "@nestjs/common";

type MetricLabels = Record<string, string>;
type MetricOutcome = "success" | "error";
type RoomControlOperation = "create_room" | "get_room" | "join_room" | "refresh_room_session";
type RedisOperation =
  | "create_room_metadata"
  | "create_room_slug"
  | "expire_room_metadata"
  | "expire_room_slug"
  | "get_room_slug"
  | "get_room_metadata"
  | "get_participant_count"
  | "get_live_participant"
  | "save_room_session"
  | "save_room_session_token_index"
  | "delete_room_session_token_index"
  | "expire_room_sessions"
  | "expire_room_session_token_index"
  | "get_room_session"
  | "find_room_session_by_token_hash"
  | "get_room_session_by_token_index"
  | "read_media_lease"
  | "readiness_ping";

const forbiddenLabelNames = new Set([
  "authorization",
  "commandId",
  "command_id",
  "participantId",
  "participant_id",
  "requestId",
  "request_id",
  "roomId",
  "room_id",
  "room_session_token",
  "roomSessionToken",
  "token",
]);

const httpDurationBuckets = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];
const operationDurationBuckets = [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5];

type HistogramState = {
  buckets: number[];
  bucketCounts: Map<string, number[]>;
  counts: Map<string, number>;
  sums: Map<string, number>;
  labelValues: Map<string, MetricLabels>;
};

@Injectable()
export class ApiMetricsService {
  private readonly counters = new Map<string, number>();
  private readonly counterLabels = new Map<string, MetricLabels>();
  private readonly histograms = new Map<string, HistogramState>();

  recordHttpRequest(input: {
    method: string;
    path: string;
    statusCode: number;
    durationMs: number;
  }): void {
    const statusClass = `${Math.trunc(input.statusCode / 100)}xx`;
    const outcome: MetricOutcome = input.statusCode >= 400 ? "error" : "success";
    const labels = {
      method: normalizeMethod(input.method),
      route: routeLabel(input.path),
      status_class: statusClass,
      outcome,
    };

    this.incrementCounter("api_http_requests_total", labels);
    this.observeHistogram("api_http_request_duration_seconds", labels, input.durationMs / 1_000, httpDurationBuckets);
  }

  recordRoomControl(input: {
    operation: RoomControlOperation;
    outcome: MetricOutcome;
    errorCode: string | null;
    durationMs: number;
  }): void {
    const labels = {
      operation: input.operation,
      outcome: input.outcome,
      error_code: input.errorCode ?? "none",
    };

    this.incrementCounter("api_room_control_total", labels);
    this.observeHistogram(
      "api_room_control_duration_seconds",
      labels,
      input.durationMs / 1_000,
      operationDurationBuckets
    );
  }

  recordRedisOperation(input: {
    operation: RedisOperation;
    outcome: MetricOutcome;
    durationMs: number;
  }): void {
    const labels = {
      operation: input.operation,
      outcome: input.outcome,
    };

    this.incrementCounter("api_redis_operations_total", labels);
    this.observeHistogram(
      "api_redis_operation_duration_seconds",
      labels,
      input.durationMs / 1_000,
      operationDurationBuckets
    );
  }

  renderPrometheus(): string {
    const lines: string[] = [
      "# HELP api_http_requests_total Total API HTTP requests.",
      "# TYPE api_http_requests_total counter",
      ...this.renderCounters("api_http_requests_total"),
      "# HELP api_http_request_duration_seconds API HTTP request latency.",
      "# TYPE api_http_request_duration_seconds histogram",
      ...this.renderHistogram("api_http_request_duration_seconds"),
      "# HELP api_room_control_total Total API room-control operations.",
      "# TYPE api_room_control_total counter",
      ...this.renderCounters("api_room_control_total"),
      "# HELP api_room_control_duration_seconds API room-control operation latency.",
      "# TYPE api_room_control_duration_seconds histogram",
      ...this.renderHistogram("api_room_control_duration_seconds"),
      "# HELP api_redis_operations_total Total API Redis operations.",
      "# TYPE api_redis_operations_total counter",
      ...this.renderCounters("api_redis_operations_total"),
      "# HELP api_redis_operation_duration_seconds API Redis operation latency.",
      "# TYPE api_redis_operation_duration_seconds histogram",
      ...this.renderHistogram("api_redis_operation_duration_seconds"),
      "# HELP process_cpu_user_seconds_total Total user CPU time spent in seconds.",
      "# TYPE process_cpu_user_seconds_total counter",
      `process_cpu_user_seconds_total ${process.cpuUsage().user / 1_000_000}`,
      "# HELP process_cpu_system_seconds_total Total system CPU time spent in seconds.",
      "# TYPE process_cpu_system_seconds_total counter",
      `process_cpu_system_seconds_total ${process.cpuUsage().system / 1_000_000}`,
      "# HELP process_resident_memory_bytes Resident memory size in bytes.",
      "# TYPE process_resident_memory_bytes gauge",
      `process_resident_memory_bytes ${process.memoryUsage().rss}`,
      "# HELP process_heap_used_bytes Process heap used in bytes.",
      "# TYPE process_heap_used_bytes gauge",
      `process_heap_used_bytes ${process.memoryUsage().heapUsed}`,
      "# HELP process_uptime_seconds Process uptime in seconds.",
      "# TYPE process_uptime_seconds gauge",
      `process_uptime_seconds ${process.uptime()}`,
      "",
    ];

    return lines.join("\n");
  }

  reset(): void {
    this.counters.clear();
    this.counterLabels.clear();
    this.histograms.clear();
  }

  private incrementCounter(name: string, labels: MetricLabels, amount = 1): void {
    const key = metricKey(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + amount);
    this.counterLabels.set(key, labels);
  }

  private observeHistogram(name: string, labels: MetricLabels, value: number, buckets: number[]): void {
    const state = this.histograms.get(name) ?? {
      buckets,
      bucketCounts: new Map<string, number[]>(),
      counts: new Map<string, number>(),
      sums: new Map<string, number>(),
      labelValues: new Map<string, MetricLabels>(),
    };
    const key = metricKey(name, labels);
    const nextBucketCounts = state.bucketCounts.get(key) ?? state.buckets.map(() => 0);
    state.buckets.forEach((bucket, index) => {
      if (value <= bucket) {
        nextBucketCounts[index] = (nextBucketCounts[index] ?? 0) + 1;
      }
    });
    state.bucketCounts.set(key, nextBucketCounts);
    state.counts.set(key, (state.counts.get(key) ?? 0) + 1);
    state.sums.set(key, (state.sums.get(key) ?? 0) + value);
    state.labelValues.set(key, labels);
    this.histograms.set(name, state);
  }

  private renderCounters(name: string): string[] {
    return Array.from(this.counters.entries())
      .filter(([key]) => key.startsWith(`${name}|`))
      .map(([key, value]) => `${name}${formatMetricLabels(this.counterLabels.get(key) ?? {})} ${value}`);
  }

  private renderHistogram(name: string): string[] {
    const state = this.histograms.get(name);
    if (!state) {
      return [];
    }

    const lines: string[] = [];
    for (const [key, bucketCounts] of state.bucketCounts.entries()) {
      const labels = state.labelValues.get(key) ?? {};
      const count = state.counts.get(key) ?? 0;
      const sum = state.sums.get(key) ?? 0;

      for (const [index, bucket] of state.buckets.entries()) {
        lines.push(`${name}_bucket${formatMetricLabels({ ...labels, le: String(bucket) })} ${bucketCounts[index] ?? 0}`);
      }
      lines.push(`${name}_bucket${formatMetricLabels({ ...labels, le: "+Inf" })} ${count}`);
      lines.push(`${name}_sum${formatMetricLabels(labels)} ${sum}`);
      lines.push(`${name}_count${formatMetricLabels(labels)} ${count}`);
    }

    return lines;
  }
}

let defaultMetrics: ApiMetricsService | undefined;

export function getApiMetrics(): ApiMetricsService {
  defaultMetrics ??= new ApiMetricsService();
  return defaultMetrics;
}

export function resetApiMetricsForTests(): void {
  getApiMetrics().reset();
}

export function formatMetricLabels(labels: MetricLabels): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) {
    return "";
  }

  const formatted = entries
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => {
      if (forbiddenLabelNames.has(key)) {
        throw new Error(`Forbidden high-cardinality metric label: ${key}`);
      }
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
        throw new Error(`Invalid metric label name: ${key}`);
      }
      if (value.length > 120) {
        throw new Error(`Metric label value is too long for ${key}`);
      }
      return `${key}="${value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
    })
    .join(",");

  return `{${formatted}}`;
}

function metricKey(name: string, labels: MetricLabels): string {
  return `${name}|${formatMetricLabels(labels)}`;
}

function normalizeMethod(method: string): string {
  const normalized = method.toUpperCase();
  return ["DELETE", "GET", "PATCH", "POST", "PUT"].includes(normalized) ? normalized : "OTHER";
}

function routeLabel(path: string): string {
  const pathname = path.split("?", 1)[0] ?? "/";
  const trimmed = pathname.replace(/\/$/, "") || "/";

  if (trimmed === "/api/v1/rooms") {
    return "/api/v1/rooms";
  }
  if (/^\/api\/v1\/rooms\/[^/]+$/.test(trimmed)) {
    return "/api/v1/rooms/:slug";
  }
  if (/^\/api\/v1\/rooms\/[^/]+\/join$/.test(trimmed)) {
    return "/api/v1/rooms/:slug/join";
  }
  if (/^\/api\/v1\/rooms\/[^/]+\/session\/refresh$/.test(trimmed)) {
    return "/api/v1/rooms/:slug/session/refresh";
  }
  if (trimmed === "/api/v1/health" || trimmed === "/api/v1/ready" || trimmed === "/api/v1/metrics") {
    return trimmed;
  }

  return "other";
}
