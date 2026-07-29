import { pino } from "pino";

/**
 * Structured logging from day one.
 *
 * The failure modes that matter here — ingest lag, a parser choking on one team's
 * report, queue backlog — are only diagnosable if every log line carries the
 * run/artifact/project it belongs to. Retrofitting correlation ids after the fact
 * is thankless work, so the context is baked into the child-logger API.
 */
export interface LogContext {
  orgId?: string;
  projectId?: string;
  runId?: string;
  artifactId?: string;
  jobId?: string;
  stage?: string;
  requestId?: string;
  [key: string]: unknown;
}

const level = process.env.LOG_LEVEL ?? "info";
const isDevelopment = (process.env.NODE_ENV ?? "development") === "development";

export const logger = pino({
  level,
  base: { service: process.env.OTEL_SERVICE_NAME ?? "test-center" },
  // Pretty output locally; JSON in every other environment so log shipping works.
  ...(isDevelopment
    ? {
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "HH:MM:ss.l", ignore: "pid,hostname,service" },
        },
      }
    : {}),
  redact: {
    paths: [
      "*.password",
      "*.token",
      "*.secret",
      "*.authorization",
      "req.headers.authorization",
      "req.headers.cookie",
    ],
    censor: "[redacted]",
  },
});

export function childLogger(context: LogContext) {
  return logger.child(context);
}

export type Logger = typeof logger;
