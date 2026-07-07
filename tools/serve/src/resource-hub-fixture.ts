import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

// TEMPORARY local resource-hub fixture. A self-contained, in-memory, infra-free
// stand-in for the real resource storage service (Spec E, which lives in the
// vela repo at services/api/src/resources/*). It lets teammates develop the
// daemon's resource features locally without standing up vela + postgres +
// MinIO: point OD_RESOURCE_HUB_URL at this fixture and everything works.
//
// It faithfully implements the SAME wire contract the daemon client speaks
// (endpoints, error codes, x-internal-token + x-workspace-* auth, freeze,
// cross-team isolation, content-addressed dedup, presigned-style blob transport
// served from this process). The daemon makes NO mock concessions — it runs its
// real client/SDK against this exactly as it would against vela.
//
// DISPOSABLE: this whole file is deleted once the vela test environment is
// stood up; the only migration is repointing OD_RESOURCE_HUB_URL at the real
// test api. The daemon needs zero code changes. Keep the contract in sync with
// services/api/src/resources/routes.ts — change one, mirror the other.

export type ResourceHubFixtureOptions = {
  host?: string;
  port?: number;
  internalToken?: string;
};

export type ResourceHubFixtureInfo = {
  origin: string;
  endpointUrl: string;
  internalToken: string;
};

export type ResourceHubFixtureServer = {
  close(): Promise<void>;
  info: ResourceHubFixtureInfo;
  reset(): void;
};

const DEFAULT_INTERNAL_TOKEN = "dev-internal-token";
const DIGEST_RE = /^[a-z0-9]+:[0-9a-f]+$/u;
const WORKSPACE_ROLES = new Set(["owner", "admin", "member"]);

type Principal = {
  memberId: string;
  teamId: string;
  role: string;
  lifecycleState: string | null;
};

type Resource = {
  id: string;
  teamId: string;
  kind: string;
  ownerMemberId: string;
  createdAt: string;
  deletedAt: string | null;
};

type ManifestEntry = {
  path: string;
  type: "file" | "dir" | "symlink";
  executable: boolean;
  blobDigest: string | null;
  symlinkTarget: string | null;
};

type Version = {
  id: string;
  resourceId: string;
  teamId: string;
  version: number;
  manifestDigest: string;
  createdByMemberId: string;
  createdAt: string;
};

type Ref = {
  resourceId: string;
  name: string;
  versionId: string;
  updatedAt: string;
  updatedByMemberId: string;
};

let idCounter = 0;
function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}_${idCounter.toString(36)}${Math.floor(idCounter * 2654435761).toString(36)}`;
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, host, () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => (error == null ? resolveClose() : rejectClose(error)));
  });
}

function serverOrigin(server: Server): string {
  const address = server.address();
  if (address == null || typeof address === "string") {
    throw new Error("resource hub fixture did not listen on TCP");
  }
  return `http://127.0.0.1:${address.port}`;
}

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolveRead, rejectRead) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("error", rejectRead);
    request.on("end", () => resolveRead(Buffer.concat(chunks)));
  });
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const body = await readBody(request);
  if (body.byteLength === 0) return {};
  return JSON.parse(body.toString("utf8"));
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(body);
}

function header(request: IncomingMessage, name: string): string | null {
  const value = request.headers[name];
  if (Array.isArray(value)) return value[0]?.trim() ?? null;
  return typeof value === "string" ? value.trim() || null : null;
}

function isFrozen(lifecycleState: string | null): boolean {
  return lifecycleState === "locked";
}

export async function startResourceHubFixtureServer(
  options: ResourceHubFixtureOptions = {},
): Promise<ResourceHubFixtureServer> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 0;
  const internalToken = options.internalToken ?? DEFAULT_INTERNAL_TOKEN;

  // In-memory state. blobBytes = object store; blobIndex = committed rows
  // (what find-missing checks), mirroring the real blobs table vs bucket split.
  const resources = new Map<string, Resource>();
  const manifests = new Map<string, ManifestEntry[]>(); // key: team\0digest
  const versions: Version[] = [];
  const refs = new Map<string, Ref>(); // key: resourceId\0name
  const blobIndex = new Set<string>(); // team\0digest
  const blobBytes = new Map<string, Buffer>(); // team/digest

  function reset(): void {
    resources.clear();
    manifests.clear();
    versions.length = 0;
    refs.clear();
    blobIndex.clear();
    blobBytes.clear();
  }

  function authenticate(
    request: IncomingMessage,
  ): { ok: true; principal: Principal } | { ok: false; status: number; error: string } {
    const token = header(request, "x-internal-token");
    if (!token || token !== internalToken) {
      return { ok: false, status: 401, error: "untrusted_caller" };
    }
    const memberId = header(request, "x-workspace-member-id");
    const teamId = header(request, "x-workspace-team-id");
    const role = header(request, "x-workspace-role");
    if (!memberId || !teamId || !role) {
      return { ok: false, status: 403, error: "missing_principal" };
    }
    if (!WORKSPACE_ROLES.has(role)) {
      return { ok: false, status: 403, error: "invalid_role" };
    }
    return {
      ok: true,
      principal: {
        memberId,
        teamId,
        role,
        lifecycleState: header(request, "x-workspace-lifecycle-state"),
      },
    };
  }

  function toResourceResponse(resource: Resource) {
    return {
      id: resource.id,
      teamId: resource.teamId,
      kind: resource.kind,
      ownerMemberId: resource.ownerMemberId,
      createdAt: resource.createdAt,
      deletedAt: resource.deletedAt,
    };
  }

  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      sendJson(response, 500, {
        error: "fixture_error",
        message: error instanceof Error ? error.message : String(error),
      });
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://fixture.local");
    const path = url.pathname;
    const method = request.method ?? "GET";

    // --- self-served "object store" (presigned PUT/GET target) -------------
    if (path.startsWith("/_blob/")) {
      const key = path.slice("/_blob/".length); // team/digest (may contain ':')
      if (method === "PUT") {
        blobBytes.set(key, await readBody(request));
        response.statusCode = 200;
        response.end("ok");
        return;
      }
      if (method === "GET" || method === "HEAD") {
        const bytes = blobBytes.get(key);
        if (bytes == null) {
          response.statusCode = 404;
          response.end("not found");
          return;
        }
        response.statusCode = 200;
        response.setHeader("content-length", String(bytes.byteLength));
        response.end(method === "HEAD" ? undefined : bytes);
        return;
      }
      response.statusCode = 405;
      response.end("method not allowed");
      return;
    }

    if (path === "/health") {
      sendJson(response, 200, { ok: true });
      return;
    }

    if (!path.startsWith("/api/v1/resources")) {
      sendJson(response, 404, { error: "not_found" });
      return;
    }

    const auth = authenticate(request);
    if (!auth.ok) {
      sendJson(response, auth.status, { error: auth.error });
      return;
    }
    const principal = auth.principal;
    const origin = serverOrigin(server);
    const segments = path.split("/").filter((s) => s.length > 0); // ["api","v1","resources",...]
    const rest = segments.slice(3); // after /api/v1/resources

    // --- blob endpoints ----------------------------------------------------
    if (rest[0] === "blobs") {
      if (method === "POST" && rest[1] === "find-missing") {
        const body = (await readJson(request)) as { digests?: unknown };
        const digests = Array.isArray(body.digests) ? body.digests : [];
        for (const digest of digests) {
          if (typeof digest !== "string" || !DIGEST_RE.test(digest)) {
            return invalidRequest(response, "digests", "digest must be algorithm-prefixed hex");
          }
        }
        const missing = [...new Set(digests as string[])].filter(
          (digest) => !blobIndex.has(`${principal.teamId} ${digest}`),
        );
        sendJson(response, 200, { missing });
        return;
      }

      if (method === "POST" && rest[1] === "uploads" && rest[2] === undefined) {
        if (frozen(response, principal)) return;
        const body = (await readJson(request)) as { blobs?: { digest?: unknown; size?: unknown }[] };
        const blobs = Array.isArray(body.blobs) ? body.blobs : [];
        const uploads: { digest: string; url: string; method: string; expiresInSeconds: number }[] = [];
        const present: string[] = [];
        for (const blob of blobs) {
          const digest = blob.digest;
          if (typeof digest !== "string" || !DIGEST_RE.test(digest)) {
            return invalidRequest(response, "blobs", "digest must be algorithm-prefixed hex");
          }
          if (blobIndex.has(`${principal.teamId} ${digest}`)) {
            present.push(digest);
          } else {
            uploads.push({
              digest,
              url: `${origin}/_blob/${encodeURIComponent(principal.teamId)}/${digest}`,
              method: "PUT",
              expiresInSeconds: 900,
            });
          }
        }
        sendJson(response, 200, { uploads, present, storeLive: true });
        return;
      }

      if (method === "POST" && rest[1] === "uploads" && rest[2] === "commit") {
        if (frozen(response, principal)) return;
        const body = (await readJson(request)) as { blobs?: { digest?: unknown; size?: unknown }[] };
        const blobs = Array.isArray(body.blobs) ? body.blobs : [];
        const notUploaded: string[] = [];
        for (const blob of blobs) {
          if (typeof blob.digest !== "string" || !DIGEST_RE.test(blob.digest)) {
            return invalidRequest(response, "blobs", "digest must be algorithm-prefixed hex");
          }
          if (!blobBytes.has(`${principal.teamId}/${blob.digest}`)) notUploaded.push(blob.digest);
        }
        if (notUploaded.length > 0) {
          sendJson(response, 409, { error: "blob_not_uploaded", digests: notUploaded });
          return;
        }
        for (const blob of blobs) {
          blobIndex.add(`${principal.teamId} ${blob.digest as string}`);
        }
        sendJson(response, 200, { recorded: blobs.length });
        return;
      }

      if (method === "GET" && rest[2] === "download") {
        const digest = decodeURIComponent(rest[1] ?? "");
        if (!blobIndex.has(`${principal.teamId} ${digest}`)) {
          sendJson(response, 404, { error: "blob_not_found" });
          return;
        }
        sendJson(response, 200, {
          digest,
          url: `${origin}/_blob/${encodeURIComponent(principal.teamId)}/${digest}`,
          method: "GET",
          expiresInSeconds: 900,
          storeLive: true,
        });
        return;
      }
    }

    // --- manifests ---------------------------------------------------------
    if (rest[0] === "manifests" && method === "GET" && rest[1] !== undefined) {
      const digest = decodeURIComponent(rest[1]);
      const entries = manifests.get(`${principal.teamId} ${digest}`);
      if (entries == null) {
        sendJson(response, 404, { error: "manifest_not_found" });
        return;
      }
      sendJson(response, 200, { digest, entries });
      return;
    }

    // --- resources collection ---------------------------------------------
    if (rest.length === 0) {
      if (method === "GET") {
        const list = [...resources.values()].filter(
          (r) => r.teamId === principal.teamId && r.deletedAt == null,
        );
        sendJson(response, 200, { resources: list.map(toResourceResponse) });
        return;
      }
      if (method === "POST") {
        if (frozen(response, principal)) return;
        const body = (await readJson(request)) as { kind?: unknown; resourceId?: unknown };
        if (typeof body.kind !== "string" || body.kind.length === 0) {
          return invalidRequest(response, "kind", "kind is required");
        }
        const id = typeof body.resourceId === "string" && body.resourceId.length > 0 ? body.resourceId : nextId("res");
        const existing = resources.get(id);
        const resource: Resource =
          existing ?? {
            id,
            teamId: principal.teamId,
            kind: body.kind,
            ownerMemberId: principal.memberId,
            createdAt: new Date().toISOString(),
            deletedAt: null,
          };
        resources.set(id, resource);
        sendJson(response, 201, toResourceResponse(resource));
        return;
      }
    }

    // --- resource-scoped ---------------------------------------------------
    const resourceId = rest[0];
    if (resourceId !== undefined && resourceId !== "blobs" && resourceId !== "manifests") {
      const resource = resources.get(resourceId);
      const visible = resource != null && resource.teamId === principal.teamId && resource.deletedAt == null;
      if (!visible) {
        sendJson(response, 404, { error: "resource_not_found" });
        return;
      }
      const isOwner = resource.ownerMemberId === principal.memberId;
      const frozenNow = isFrozen(principal.lifecycleState);
      const canEdit = isOwner && !frozenNow;

      // GET /:id
      if (rest.length === 1 && method === "GET") {
        sendJson(response, 200, toResourceResponse(resource));
        return;
      }

      // versions
      if (rest[1] === "versions") {
        if (method === "GET") {
          const list = versions
            .filter((v) => v.resourceId === resourceId)
            .sort((a, b) => b.version - a.version)
            .map((v) => ({
              id: v.id,
              resourceId: v.resourceId,
              version: v.version,
              manifestDigest: v.manifestDigest,
              createdByMemberId: v.createdByMemberId,
              createdAt: v.createdAt,
            }));
          sendJson(response, 200, { versions: list });
          return;
        }
        if (method === "POST") {
          if (!canEdit) {
            sendJson(response, 403, { error: frozenNow && isOwner ? "resource_frozen" : "forbidden" });
            return;
          }
          const body = (await readJson(request)) as {
            manifestDigest?: unknown;
            entries?: unknown;
            ref?: unknown;
            expectedVersionId?: unknown;
          };
          if (typeof body.manifestDigest !== "string" || !DIGEST_RE.test(body.manifestDigest)) {
            return invalidRequest(response, "manifestDigest", "digest must be algorithm-prefixed hex");
          }
          const entries = normalizeEntries(body.entries);
          const manifestKey = `${principal.teamId} ${body.manifestDigest}`;
          if (!manifests.has(manifestKey)) manifests.set(manifestKey, entries);
          const nextVersion =
            versions.filter((v) => v.resourceId === resourceId).reduce((max, v) => Math.max(max, v.version), 0) + 1;
          const version: Version = {
            id: nextId("ver"),
            resourceId,
            teamId: principal.teamId,
            version: nextVersion,
            manifestDigest: body.manifestDigest,
            createdByMemberId: principal.memberId,
            createdAt: new Date().toISOString(),
          };
          versions.push(version);
          if (typeof body.ref === "string" && body.ref.length > 0) {
            const conflict = setRef(
              resourceId,
              body.ref,
              version.id,
              principal.memberId,
              body.expectedVersionId,
            );
            if (conflict != null) {
              sendJson(response, 409, {
                error: "ref_conflict",
                currentVersionId: conflict,
                createdVersionId: version.id,
              });
              return;
            }
          }
          sendJson(response, 201, {
            id: version.id,
            resourceId: version.resourceId,
            version: version.version,
            manifestDigest: version.manifestDigest,
            createdByMemberId: version.createdByMemberId,
            createdAt: version.createdAt,
          });
          return;
        }
      }

      // refs
      if (rest[1] === "refs" && rest[2] !== undefined) {
        const name = decodeURIComponent(rest[2]);
        if (method === "GET") {
          const ref = refs.get(`${resourceId} ${name}`);
          if (ref == null) {
            sendJson(response, 404, { error: "ref_not_found" });
            return;
          }
          sendJson(response, 200, ref);
          return;
        }
        if (method === "PUT") {
          if (!canEdit) {
            sendJson(response, 403, { error: frozenNow && isOwner ? "resource_frozen" : "forbidden" });
            return;
          }
          const body = (await readJson(request)) as { versionId?: unknown; expectedVersionId?: unknown };
          if (typeof body.versionId !== "string" || body.versionId.length === 0) {
            return invalidRequest(response, "versionId", "versionId is required");
          }
          const conflict = setRef(resourceId, name, body.versionId, principal.memberId, body.expectedVersionId);
          if (conflict !== null && body.expectedVersionId !== undefined) {
            sendJson(response, 409, { error: "ref_conflict", currentVersionId: conflict });
            return;
          }
          sendJson(response, 200, refs.get(`${resourceId} ${name}`));
          return;
        }
      }
    }

    sendJson(response, 404, { error: "not_found" });
  }

  // Returns the current versionId (conflict) when expectedVersionId is given and
  // does not match; otherwise applies the update and returns null.
  function setRef(
    resourceId: string,
    name: string,
    versionId: string,
    memberId: string,
    expectedVersionId: unknown,
  ): string | null {
    const key = `${resourceId} ${name}`;
    const current = refs.get(key) ?? null;
    if (expectedVersionId !== undefined) {
      const currentVersionId = current?.versionId ?? null;
      const expected = expectedVersionId === null ? null : String(expectedVersionId);
      if (currentVersionId !== expected) return currentVersionId ?? "";
    }
    refs.set(key, {
      resourceId,
      name,
      versionId,
      updatedByMemberId: memberId,
      updatedAt: new Date().toISOString(),
    });
    return null;
  }

  function frozen(response: ServerResponse, principal: Principal): boolean {
    if (isFrozen(principal.lifecycleState)) {
      sendJson(response, 403, { error: "resource_frozen" });
      return true;
    }
    return false;
  }

  function invalidRequest(response: ServerResponse, path: string, message: string): void {
    sendJson(response, 400, { error: "invalid_request", issues: [{ path, message }] });
  }

  await listen(server, port, host);
  const origin = serverOrigin(server);

  return {
    close: () => close(server),
    info: { origin, endpointUrl: origin, internalToken },
    reset,
  };
}

function normalizeEntries(raw: unknown): ManifestEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((entry) => {
    const e = entry as Record<string, unknown>;
    return {
      path: String(e.path ?? ""),
      type: (e.type === "dir" || e.type === "symlink" ? e.type : "file") as ManifestEntry["type"],
      executable: e.executable === true,
      blobDigest: typeof e.blobDigest === "string" ? e.blobDigest : null,
      symlinkTarget: typeof e.symlinkTarget === "string" ? e.symlinkTarget : null,
    };
  });
}
