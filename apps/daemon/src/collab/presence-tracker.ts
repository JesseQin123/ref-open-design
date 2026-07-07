// Team collaboration presence — the "presence" overlay: who is currently viewing a
// shared project. Decoupled from the resource/sync layer: it is a
// lightweight, poll-friendly heartbeat set, not a realtime-cursor engine (live
// cursors were cut; content is polled).
//
// Pure and timer-free by design. `present()` computes the live set on demand and
// sweeps anyone whose heartbeat has aged past the TTL, so the orchestrator's
// existing poll loop surfaces departures without a background timer. Explicit
// join/leave fire `onChange` immediately so an active viewer's arrival/exit can
// be broadcast without waiting for the next poll.

import type { CollabPresenceMember } from '@open-design/contracts';

// The presence identity shape is the shared contract DTO; keep the local name
// for existing daemon-side imports.
export type PresenceMember = CollabPresenceMember;

export interface CollabPresenceTrackerOptions {
  /** A member is considered gone this long after their last heartbeat. */
  ttlMs?: number;
  now?: () => number;
  /** Fired when a project's present set changes via an explicit join or leave. */
  onChange?: (result: { projectId: string; present: PresenceMember[] }) => void;
}

interface Entry {
  member: PresenceMember;
  lastSeen: number;
}

const DEFAULT_TTL_MS = 30_000;

export class CollabPresenceTracker {
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly onChange?: CollabPresenceTrackerOptions['onChange'];
  private readonly projects = new Map<string, Map<string, Entry>>();

  constructor(options: CollabPresenceTrackerOptions = {}) {
    this.ttlMs = Math.max(0, options.ttlMs ?? DEFAULT_TTL_MS);
    this.now = options.now ?? Date.now;
    this.onChange = options.onChange;
  }

  /** Mark a member present in a project (call on view + on each poll). */
  heartbeat(projectId: string, member: PresenceMember): void {
    const entries = this.ensure(projectId);
    const isNew = !entries.has(member.memberId);
    entries.set(member.memberId, { member, lastSeen: this.now() });
    if (isNew) this.emit(projectId);
  }

  /** Explicit departure (tab closed / left the project). */
  leave(projectId: string, memberId: string): void {
    const entries = this.projects.get(projectId);
    if (!entries || !entries.delete(memberId)) return;
    if (entries.size === 0) this.projects.delete(projectId);
    this.emit(projectId);
  }

  /** Members present now — sweeps any whose heartbeat aged past the TTL. */
  present(projectId: string): PresenceMember[] {
    const entries = this.projects.get(projectId);
    if (!entries) return [];
    const cutoff = this.now() - this.ttlMs;
    for (const [memberId, entry] of entries) {
      if (entry.lastSeen < cutoff) entries.delete(memberId);
    }
    if (entries.size === 0) {
      this.projects.delete(projectId);
      return [];
    }
    return Array.from(entries.values(), (entry) => entry.member);
  }

  dispose(): void {
    this.projects.clear();
  }

  private emit(projectId: string): void {
    if (this.onChange) this.onChange({ projectId, present: this.present(projectId) });
  }

  private ensure(projectId: string): Map<string, Entry> {
    let entries = this.projects.get(projectId);
    if (!entries) {
      entries = new Map();
      this.projects.set(projectId, entries);
    }
    return entries;
  }
}
