import { useEffect, useRef, useState } from 'react';
import type { WorkspaceCollabContext } from '@open-design/contracts';
import { Icon } from './Icon';
import { useI18n } from '../i18n';
import { navigate } from '../router';
import styles from './WorkspaceSwitcher.module.css';

// The team-workspace affordance in the top bar. When the signed-in identity is a
// team workspace, it surfaces the current team and a small menu (invite / new
// team). It reads the one workspace context the rest of the collab surface reads,
// so a personal or local session simply renders nothing — the team switcher only
// appears once you are actually in a team. Membership management itself lives in
// the cloud/onboarding flow, so those actions route there rather than pretending
// to manage a roster the client does not own.
export function WorkspaceSwitcher() {
  const { t } = useI18n();
  const [context, setContext] = useState<WorkspaceCollabContext | null>(null);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/workspace/context');
        if (!res.ok) return;
        const body = (await res.json()) as { context?: WorkspaceCollabContext | null };
        if (!cancelled) setContext(body.context ?? null);
      } catch {
        // Personal / offline: leave the switcher hidden.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  if (!context || context.workspaceType !== 'team') return null;

  const teamName = context.teamName?.trim() || context.teamId || t('workspaceSwitcher.team');
  const initial = teamName.trim().charAt(0).toUpperCase() || 'T';

  const goToTeamFlow = () => {
    setOpen(false);
    navigate({ kind: 'home', view: 'onboarding' });
  };

  return (
    <div className={styles.wrap} ref={wrapRef}>
      <button
        type="button"
        className={styles.trigger}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={teamName}
        data-testid="workspace-switcher"
      >
        <span className={styles.avatar} aria-hidden>
          {initial}
        </span>
        <span className={styles.name}>{teamName}</span>
        <Icon name="chevron-down" size={14} />
      </button>
      {open ? (
        <div className={styles.menu} role="menu">
          <button type="button" className={`${styles.item} ${styles.itemCurrent}`} role="menuitem" disabled>
            <span className={styles.avatar} aria-hidden>
              {initial}
            </span>
            <span className={styles.itemName}>{teamName}</span>
            <Icon name="check" size={14} />
          </button>
          <div className={styles.divider} role="separator" />
          <button type="button" className={styles.item} role="menuitem" onClick={goToTeamFlow}>
            <Icon name="send" size={15} />
            {t('workspaceSwitcher.invite')}
          </button>
          <button type="button" className={styles.item} role="menuitem" onClick={goToTeamFlow}>
            <Icon name="plus" size={15} />
            {t('workspaceSwitcher.createTeam')}
          </button>
        </div>
      ) : null}
    </div>
  );
}
