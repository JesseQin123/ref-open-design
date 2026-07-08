// Team collaboration client integration. Ties the daemon collab capabilities
// together for a shared-project session: heartbeat presence, poll the published
// head version (so a member knows when to pull), and report author-side changes
// / request a publish. It is the glue the read-only collab view consumes.
//
// Polling-based by design (live cursors were cut; content is polled — the spec).

import type { CollabPresenceMember, ProjectSyncState } from '@open-design/contracts';

// Presence identity is the shared contract DTO; re-export so collab consumers
// keep importing it from the client module.
export type { CollabPresenceMember };

export interface CollabSnapshot {
  present: CollabPresenceMember[];
  publishedVersion: number | null;
  /**  project sync state; null until the first status poll lands. */
  syncState: ProjectSyncState | null;
  /** The member who shared this project (its single writer); null if unshared. */
  ownerMemberId: string | null;
}

export interface CollabClientOptions {
  projectId: string;
  member: CollabPresenceMember;
  /** Injectable for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Daemon API base; default '' (same origin). */
  baseUrl?: string;
  heartbeatMs?: number;
  statusPollMs?: number;
  onUpdate?: (snapshot: CollabSnapshot) => void;
  onError?: (error: unknown) => void;
}

const DEFAULT_HEARTBEAT_MS = 10_000;
const DEFAULT_STATUS_POLL_MS = 5_000;

export class CollabClient {
  private readonly projectId: string;
  private readonly member: CollabPresenceMember;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly heartbeatMs: number;
  private readonly statusPollMs: number;
  private readonly onUpdate?: CollabClientOptions['onUpdate'];
  private readonly onError?: CollabClientOptions['onError'];
  private readonly timers: ReturnType<typeof setInterval>[] = [];
  private snapshot: CollabSnapshot = { present: [], publishedVersion: null, syncState: null, ownerMemberId: null };
  private running = false;

  constructor(options: CollabClientOptions) {
    this.projectId = options.projectId;
    this.member = options.member;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.baseUrl = options.baseUrl ?? '';
    this.heartbeatMs = Math.max(1_000, options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);
    this.statusPollMs = Math.max(1_000, options.statusPollMs ?? DEFAULT_STATUS_POLL_MS);
    this.onUpdate = options.onUpdate;
    this.onError = options.onError;
  }

  getSnapshot(): CollabSnapshot {
    return this.snapshot;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.heartbeat();
    void this.pollStatus();
    this.timers.push(setInterval(() => void this.heartbeat(), this.heartbeatMs));
    this.timers.push(setInterval(() => void this.pollStatus(), this.statusPollMs));
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    for (const timer of this.timers) clearInterval(timer);
    this.timers.length = 0;
    void this.leave();
  }

  /** The author edited a file — schedule a coalesced publish. */
  async reportChange(): Promise<void> {
    await this.post('/collab/changed');
  }

  /** Run boundary — flush the pending publish now. */
  async requestPublish(): Promise<void> {
    await this.post('/collab/publish');
  }

  async heartbeat(): Promise<void> {
    try {
      const body = await this.post('/presence/heartbeat', this.member);
      if (Array.isArray(body?.present)) this.update({ present: body.present as CollabPresenceMember[] });
    } catch (error) {
      this.onError?.(error);
    }
  }

  async pollStatus(): Promise<void> {
    try {
      const body = await this.get('/collab/status');
      const version = typeof body?.publishedVersion === 'number' ? body.publishedVersion : null;
      const syncState = (body?.syncState as ProjectSyncState | undefined) ?? null;
      const ownerMemberId = typeof body?.ownerMemberId === 'string' ? body.ownerMemberId : null;
      this.update({ publishedVersion: version, syncState, ownerMemberId });
    } catch (error) {
      this.onError?.(error);
    }
  }

  private async leave(): Promise<void> {
    try {
      await this.post('/presence/leave', { memberId: this.member.memberId });
    } catch (error) {
      this.onError?.(error);
    }
  }

  /**
   * Best-effort leave that survives page unload. A normal fetch is aborted when
   * the tab closes, so a hard close would otherwise leave the member lingering
   * until the daemon's presence TTL sweeps it (~30s). sendBeacon (with a
   * keepalive-fetch fallback) hands the request to the browser to deliver after
   * the page is gone, so the present set drops promptly.
   */
  leaveBeacon(): void {
    const url = this.url('/presence/leave');
    const body = JSON.stringify({ memberId: this.member.memberId });
    try {
      if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
        const blob = new Blob([body], { type: 'application/json' });
        if (navigator.sendBeacon(url, blob)) return;
      }
    } catch {
      // fall through to the keepalive fetch
    }
    void this.fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => {});
  }

  private update(patch: Partial<CollabSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    this.onUpdate?.(this.snapshot);
  }

  private async get(path: string): Promise<Record<string, unknown> | null> {
    const response = await this.fetchImpl(this.url(path));
    if (!response.ok) throw new Error(`collab GET ${path} failed: ${response.status}`);
    return (await response.json()) as Record<string, unknown>;
  }

  private async post(path: string, body?: unknown): Promise<Record<string, unknown> | null> {
    const init: RequestInit = { method: 'POST' };
    if (body !== undefined) {
      init.headers = { 'content-type': 'application/json' };
      init.body = JSON.stringify(body);
    }
    const response = await this.fetchImpl(this.url(path), init);
    if (!response.ok) throw new Error(`collab POST ${path} failed: ${response.status}`);
    return (await response.json()) as Record<string, unknown>;
  }

  private url(path: string): string {
    return `${this.baseUrl}/api/projects/${encodeURIComponent(this.projectId)}${path}`;
  }
}
