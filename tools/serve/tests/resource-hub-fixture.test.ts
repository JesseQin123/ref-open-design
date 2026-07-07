import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  type ResourceHubFixtureServer,
  startResourceHubFixtureServer,
} from "../src/resource-hub-fixture.js";

type Principal = { member: string; team: string; role?: string; life?: string };

const TOKEN = "dev-internal-token";

function headers(principal?: Principal, token: string | null = TOKEN): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (token != null) h["x-internal-token"] = token;
  if (principal) {
    h["x-workspace-member-id"] = principal.member;
    h["x-workspace-team-id"] = principal.team;
    h["x-workspace-role"] = principal.role ?? "owner";
    if (principal.life) h["x-workspace-lifecycle-state"] = principal.life;
  }
  return h;
}

async function call(
  server: ResourceHubFixtureServer,
  method: string,
  path: string,
  principal?: Principal,
  body?: unknown,
  token: string | null = TOKEN,
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${server.info.origin}${path}`, {
    method,
    headers: headers(principal, token),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : {} };
}

const sha256 = (s: string) => `sha256:${createHash("sha256").update(s).digest("hex")}`;

describe("resource-hub fixture", () => {
  it("runs the full index + presigned byte loop", async () => {
    const server = await startResourceHubFixtureServer();
    const owner: Principal = { member: "m1", team: "t1" };
    try {
      const created = await call(server, "POST", "/api/v1/resources", owner, {
        kind: "design_system",
      });
      expect(created.status).toBe(201);
      const resourceId = created.json.id as string;

      const content = "tokens";
      const digest = sha256(content);
      const missing = await call(server, "POST", "/api/v1/resources/blobs/find-missing", owner, {
        digests: [digest],
      });
      expect(missing.json.missing).toEqual([digest]);

      const prep = await call(server, "POST", "/api/v1/resources/blobs/uploads", owner, {
        blobs: [{ digest, size: content.length }],
      });
      expect(prep.json.storeLive).toBe(true);
      const uploadUrl = prep.json.uploads[0].url as string;

      // Presigned PUT straight to the fixture's own object store.
      const put = await fetch(uploadUrl, { method: "PUT", body: content });
      expect(put.ok).toBe(true);

      const commit = await call(server, "POST", "/api/v1/resources/blobs/uploads/commit", owner, {
        blobs: [{ digest, size: content.length }],
      });
      expect(commit.status).toBe(200);

      const manifestDigest = sha256("manifest");
      const publish = await call(server, "POST", `/api/v1/resources/${resourceId}/versions`, owner, {
        manifestDigest,
        entries: [{ path: "tokens.json", type: "file", blobDigest: digest }],
        ref: "latest",
      });
      expect(publish.status).toBe(201);
      const versionId = publish.json.id as string;

      const ref = await call(server, "GET", `/api/v1/resources/${resourceId}/refs/latest`, owner);
      expect(ref.json.versionId).toBe(versionId);

      const manifest = await call(server, "GET", `/api/v1/resources/manifests/${manifestDigest}`, owner);
      expect(manifest.json.entries[0].blobDigest).toBe(digest);

      const dl = await call(server, "GET", `/api/v1/resources/blobs/${digest}/download`, owner);
      const got = await fetch(dl.json.url as string);
      expect(await got.text()).toBe(content);
    } finally {
      await server.close();
    }
  });

  it("enforces auth, freeze, isolation and optimistic concurrency", async () => {
    const server = await startResourceHubFixtureServer();
    const owner: Principal = { member: "m1", team: "t1" };
    try {
      // auth
      expect((await call(server, "GET", "/api/v1/resources", owner, undefined, "wrong")).status).toBe(401);
      expect((await call(server, "GET", "/api/v1/resources", undefined)).status).toBe(403);

      // not-found + bad input
      expect((await call(server, "GET", "/api/v1/resources/nope", owner)).json.error).toBe("resource_not_found");
      expect(
        (await call(server, "POST", "/api/v1/resources/blobs/find-missing", owner, { digests: ["bad"] })).status,
      ).toBe(400);

      // frozen
      const frozen = await call(server, "POST", "/api/v1/resources", { ...owner, life: "locked" }, {
        kind: "design_system",
      });
      expect(frozen.status).toBe(403);
      expect(frozen.json.error).toBe("resource_frozen");

      // set up a resource + version
      const res = await call(server, "POST", "/api/v1/resources", owner, { kind: "design_system" });
      const id = res.json.id as string;
      const md = sha256("m");
      const v1 = await call(server, "POST", `/api/v1/resources/${id}/versions`, owner, {
        manifestDigest: md,
        entries: [],
        ref: "latest",
      });
      expect(v1.status).toBe(201);

      // 409 stale ref
      const conflict = await call(server, "POST", `/api/v1/resources/${id}/versions`, owner, {
        manifestDigest: md,
        entries: [],
        ref: "latest",
        expectedVersionId: "stale",
      });
      expect(conflict.status).toBe(409);
      expect(conflict.json.error).toBe("ref_conflict");

      // forbidden: same team, non-creator cannot publish
      const forbidden = await call(server, "POST", `/api/v1/resources/${id}/versions`, { member: "m2", team: "t1" }, {
        manifestDigest: md,
        entries: [],
      });
      expect(forbidden.status).toBe(403);
      expect(forbidden.json.error).toBe("forbidden");

      // cross-team isolation
      expect((await call(server, "GET", `/api/v1/resources/${id}`, { member: "x", team: "t2" })).status).toBe(404);
    } finally {
      await server.close();
    }
  });
});
