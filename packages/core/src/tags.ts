import { z } from "zod";

/**
 * Tags are a core primitive, not a label field.
 *
 * They are indexed (GIN) on both runs and individual results, and they drive
 * saved views, team dashboards, alert routing and quality-gate scoping. Reserved
 * keys get first-class UI treatment and are validated; everything else is free
 * form so teams are never blocked waiting on us to add a field.
 */
export const RESERVED_TAG_KEYS = [
  "env",
  "branch",
  "suite",
  "browser",
  "device",
  "platform",
  "shard",
  "release",
  "owner",
  "severity",
  "component",
] as const;

export type ReservedTagKey = (typeof RESERVED_TAG_KEYS)[number];

export const MAX_TAGS_PER_ENTITY = 50;
export const MAX_TAG_KEY_LENGTH = 40;
export const MAX_TAG_VALUE_LENGTH = 200;

/** Keys are normalized to lowercase kebab/snake so `Env` and `env` never diverge. */
export const tagKeySchema = z
  .string()
  .min(1)
  .max(MAX_TAG_KEY_LENGTH)
  .regex(
    /^[a-z0-9][a-z0-9_-]*$/,
    "tag keys must be lowercase alphanumeric, optionally containing - or _",
  );

export const tagValueSchema = z.string().min(1).max(MAX_TAG_VALUE_LENGTH);

export const tagsSchema = z
  .record(tagKeySchema, tagValueSchema)
  .refine((tags) => Object.keys(tags).length <= MAX_TAGS_PER_ENTITY, {
    message: `at most ${MAX_TAGS_PER_ENTITY} tags per entity`,
  });

export type Tags = z.infer<typeof tagsSchema>;

/** Lowercases and trims keys, drops empty values. Used on every ingest path. */
export function normalizeTags(input: Record<string, unknown> | undefined | null): Tags {
  if (!input) return {};
  const out: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(input)) {
    if (rawValue === null || rawValue === undefined) continue;
    const key = String(rawKey).trim().toLowerCase().replace(/\s+/g, "-");
    const value = String(rawValue).trim();
    if (!key || !value) continue;
    out[key.slice(0, MAX_TAG_KEY_LENGTH)] = value.slice(0, MAX_TAG_VALUE_LENGTH);
  }
  return out;
}

/**
 * Parses CLI/CI-friendly `key:value` tag arguments.
 * `--tag suite:smoke --tag browser:chromium` and `--tag suite=smoke` both work,
 * because CI authors will inevitably try both.
 */
export function parseTagArgs(args: readonly string[]): Tags {
  const raw: Record<string, string> = {};
  for (const arg of args) {
    const match = /^([^:=]+)[:=](.*)$/.exec(arg);
    if (!match) continue;
    const [, key, value] = match;
    if (key === undefined || value === undefined) continue;
    raw[key] = value;
  }
  return normalizeTags(raw);
}
