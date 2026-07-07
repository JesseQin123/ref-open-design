import type { Express } from 'express';
import type { CollabRuntime } from '../collab/runtime.js';
import type { PresenceMember } from '../collab/presence-tracker.js';

export interface RegisterCollabPresenceRoutesDeps {
  collab: Pick<CollabRuntime, 'presence'>;
}

function readMember(body: unknown): PresenceMember | null {
  const raw = (body ?? {}) as Record<string, unknown>;
  const memberId = typeof raw.memberId === 'string' ? raw.memberId.trim() : '';
  if (!memberId) return null;
  const member: PresenceMember = { memberId };
  if (typeof raw.name === 'string' && raw.name.trim()) member.name = raw.name.trim();
  if (raw.role === 'owner' || raw.role === 'admin' || raw.role === 'member') member.role = raw.role;
  return member;
}

/**
 * Team collaboration presence (presence) capability. Members heartbeat while viewing a
 * shared project; clients poll the present set (live cursors were cut, content
 * is polled — the spec). The set is process-local in {@link CollabRuntime}.
 */
export function registerCollabPresenceRoutes(app: Express, deps: RegisterCollabPresenceRoutesDeps): void {
  const { presence } = deps.collab;

  app.get('/api/projects/:id/presence', (req, res) => {
    res.json({ present: presence.present(req.params.id) });
  });

  app.post('/api/projects/:id/presence/heartbeat', (req, res) => {
    const member = readMember(req.body);
    if (!member) return res.status(400).json({ error: 'memberId required' });
    presence.heartbeat(req.params.id, member);
    res.json({ present: presence.present(req.params.id) });
  });

  app.post('/api/projects/:id/presence/leave', (req, res) => {
    const memberId = typeof (req.body as Record<string, unknown> | undefined)?.memberId === 'string'
      ? ((req.body as Record<string, unknown>).memberId as string).trim()
      : '';
    if (!memberId) return res.status(400).json({ error: 'memberId required' });
    presence.leave(req.params.id, memberId);
    res.json({ ok: true, present: presence.present(req.params.id) });
  });
}
