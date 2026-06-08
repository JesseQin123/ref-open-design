# Open Design Telemetry Relay

Cloudflare Worker relay for opt-in Open Design telemetry. The shipped desktop
client sends redacted Langfuse ingestion batches here after the user enables
metrics. This Worker holds the Langfuse write credentials and forwards valid
batches to Langfuse.

The relay keeps Langfuse secret keys out of packaged clients. Release builds
only include the public relay URL; the Worker adds Langfuse authentication
server-side after validating the request. If the relay is unavailable, the
daemon retries, logs the failure, and continues the user flow without blocking
the CLI or desktop app.

The same Worker also exposes a write-only trace object ingest endpoint at
`POST /api/objects/batch`. It accepts Open Design observability objects such as
attachments, produced artifacts, and over-threshold input text snapshots, writes
them through the `TRACE_OBJECT_BUCKET` R2 binding, and returns trace-safe
`storage_ref` / `sha256` / size metadata for Langfuse manifests.

Local development can bypass the relay by setting direct `LANGFUSE_PUBLIC_KEY`
and `LANGFUSE_SECRET_KEY` environment variables for the daemon. Packaged
release config should use only `OPEN_DESIGN_TELEMETRY_RELAY_URL`.

## Abuse controls

The Worker requires the Open Design telemetry marker header, validates the
Langfuse ingestion batch shape and size before forwarding, and uses Cloudflare
Rate Limiting bindings for two independent keys:

- `TELEMETRY_CLIENT_RATE_LIMITER`: anonymous installation/user id, 120 requests
  per minute.
- `TELEMETRY_IP_RATE_LIMITER`: Cloudflare `CF-Connecting-IP`, 600 requests per
  minute.

Object ingest uses the same rate limit bindings with a separate marker value,
`X-Open-Design-Telemetry: object-ingestion-v1`. The Worker enforces a 50 MiB
single-object limit and a 100 MiB request-body limit by default. Oversized
objects are reported as unavailable instead of being written.

## Secrets

```bash
pnpm --dir apps/telemetry-worker dlx wrangler secret put LANGFUSE_PUBLIC_KEY
pnpm --dir apps/telemetry-worker dlx wrangler secret put LANGFUSE_SECRET_KEY
```

`LANGFUSE_BASE_URL` defaults to `https://us.cloud.langfuse.com` in
`wrangler.toml`.

Object ingest should use a Cloudflare R2 binding, not S3/R2 access keys in the
packaged client or daemon. Required worker configuration:

```toml
[[r2_buckets]]
binding = "TRACE_OBJECT_BUCKET"
bucket_name = "open-design-observability"

[vars]
TRACE_OBJECT_PREFIX = "observability"
TRACE_OBJECT_MAX_BYTES = "52428800"
TRACE_OBJECT_BATCH_MAX_BYTES = "104857600"
```

## Deploy

```bash
pnpm --filter @open-design/telemetry-worker deploy
```

After deploy, set the repository variable `OPEN_DESIGN_TELEMETRY_RELAY_URL` to
the Worker route, for example:

```text
https://telemetry.open-design.ai/api/langfuse
```

Opening `/api/langfuse` or `/health` in a browser returns relay health JSON.
Telemetry ingestion still uses POST to `/api/langfuse`.
Object ingestion uses POST to `/api/objects/batch`.

Release workflows bake only this public relay URL into packaged config. The
Langfuse secret key stays in Cloudflare Worker secrets.
