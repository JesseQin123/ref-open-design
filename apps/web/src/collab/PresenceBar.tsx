import type { CollabPresenceMember } from './collab-client';
import styles from './PresenceBar.module.css';

export interface PresenceBarProps {
  members: CollabPresenceMember[];
  /** Max avatars before collapsing into a "+N" chip. */
  max?: number;
  /** The viewer's own member id — excluded from the overlay. */
  selfMemberId?: string;
}

function initials(member: CollabPresenceMember): string {
  const source = (member.name?.trim() || member.memberId).trim();
  const parts = source.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    const first = parts[0]![0] ?? '';
    const second = parts[1]![0] ?? '';
    return (first + second).toUpperCase();
  }
  return source.slice(0, 2).toUpperCase();
}

/**
 * Presence overlay (presence, the spec): a compact avatar stack of the members
 * currently viewing the shared project. Poll-driven — the set comes from
 * {@link useCollab}; there are no live cursors.
 */
export function PresenceBar({ members, max = 5, selfMemberId }: PresenceBarProps) {
  const others = members.filter((m) => m.memberId !== selfMemberId);
  if (others.length === 0) return null;

  const shown = others.slice(0, max);
  const overflow = others.length - shown.length;

  return (
    <div
      className={styles.bar}
      role="group"
      aria-label={`${others.length} collaborator${others.length === 1 ? '' : 's'} present`}
    >
      {shown.map((member) => (
        <span
          key={member.memberId}
          className={styles.avatar}
          data-role={member.role ?? 'member'}
          title={member.name ?? member.memberId}
        >
          {initials(member)}
        </span>
      ))}
      {overflow > 0 && (
        <span className={styles.overflow} title={`${overflow} more present`}>
          +{overflow}
        </span>
      )}
    </div>
  );
}
