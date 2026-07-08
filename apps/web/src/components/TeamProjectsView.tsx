import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@open-design/components';
import type { WorkspaceCollabContext } from '@open-design/contracts';

import { useT } from '../i18n';
import {
  listWorkspaceProjects,
  moveWorkspaceProject,
  type WorkspaceProjectSummary,
  type WorkspaceProjectVisibility,
} from '../state/workspace-projects';
import { Icon } from './Icon';
import styles from './TeamProjectsView.module.css';

interface Props {
  mode: 'drafts' | 'all-projects';
  context: WorkspaceCollabContext;
  onOpenProject: (id: string) => Promise<boolean> | boolean | void;
}

export function TeamProjectsView({ mode, context, onOpenProject }: Props) {
  const t = useT();
  const [projects, setProjects] = useState<WorkspaceProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [movingProjectId, setMovingProjectId] = useState<string | null>(null);

  const view = mode === 'drafts' ? 'drafts' : 'all';
  const title = mode === 'drafts' ? t('entry.navDrafts') : t('entry.navAllProjects');

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await listWorkspaceProjects({
        workspaceId: context.workspaceId,
        view,
      });
      setProjects(next);
    } catch {
      setError(t('teamProjects.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [context.workspaceId, t, view]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const counts = useMemo(() => {
    let personal = 0;
    let team = 0;
    for (const project of projects) {
      if (project.visibility === 'team') team += 1;
      else personal += 1;
    }
    return { personal, team };
  }, [projects]);

  async function moveProject(project: WorkspaceProjectSummary, visibility: WorkspaceProjectVisibility) {
    setMovingProjectId(project.id);
    setError(null);
    try {
      const moved = await moveWorkspaceProject({
        workspaceId: context.workspaceId,
        projectId: project.id,
        visibility,
      });
      setProjects((current) => {
        const next = current.map((item) => (item.id === moved.id ? moved : item));
        return mode === 'drafts' ? next.filter((item) => item.visibility === 'personal') : next;
      });
    } catch {
      setError(t('teamProjects.moveFailed'));
    } finally {
      setMovingProjectId(null);
    }
  }

  return (
    <div className="entry-section">
      <header className={styles.header}>
        <div className={styles.titleBlock}>
          <h1 className="entry-section__title">{title}</h1>
          <div className={styles.meta}>
            <span>{t('teamProjects.count', { count: projects.length })}</span>
            {mode === 'all-projects' ? (
              <>
                <span aria-hidden>·</span>
                <span>{t('teamProjects.personalCount', { count: counts.personal })}</span>
                <span aria-hidden>·</span>
                <span>{t('teamProjects.sharedCount', { count: counts.team })}</span>
              </>
            ) : null}
          </div>
        </div>
        <Button
          type="button"
          variant="ghost"
          onClick={() => void refresh()}
          disabled={loading}
          aria-label={t('teamProjects.refresh')}
        >
          <Icon name={loading ? 'spinner' : 'refresh'} size={14} />
          {t('teamProjects.refresh')}
        </Button>
      </header>

      {error ? <div className={styles.error} role="alert">{error}</div> : null}

      {loading && projects.length === 0 ? (
        <div className={styles.empty}>{t('teamProjects.loading')}</div>
      ) : projects.length === 0 ? (
        <div className={styles.empty}>
          {mode === 'drafts' ? t('teamProjects.emptyDrafts') : t('teamProjects.emptyAll')}
        </div>
      ) : (
        <div className={styles.grid}>
          {projects.map((project) => {
            const moving = movingProjectId === project.id;
            const canMoveToTeam = project.currentUserAccess.canMoveToTeam && context.permissions.canShareProjects;
            const canMoveToPersonal = project.currentUserAccess.canMoveToPersonal && context.permissions.canWriteSyncedFiles;
            return (
              <article key={project.id} className={styles.card}>
                <div className={styles.iconWrap} aria-hidden>
                  <Icon name={project.visibility === 'team' ? 'share' : 'file'} size={18} />
                </div>
                <div className={styles.cardBody}>
                  <div className={styles.tagRow}>
                    <span className={styles.tag}>
                      {project.visibility === 'team'
                        ? t('teamProjects.visibilityTeam')
                        : t('teamProjects.visibilityPersonal')}
                    </span>
                    {project.visibility === 'team' ? (
                      <span className={`${styles.tag} ${styles.sharedTag}`}>
                        {t('teamProjects.sharedBadge')}
                      </span>
                    ) : null}
                    {project.syncState !== 'local_only' ? (
                      <span className={styles.tag}>
                        {syncLabel(project.syncState, t)}
                      </span>
                    ) : null}
                  </div>
                  <h2 className={styles.name}>{project.name}</h2>
                  <div className={styles.subline}>
                    <span>{projectKindLabel(project, t)}</span>
                    <span aria-hidden>·</span>
                    <span>{relativeTime(project.updatedAt, t)}</span>
                  </div>
                </div>
                <div className={styles.actions}>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => void onOpenProject(project.id)}
                    disabled={!project.currentUserAccess.canOpen}
                  >
                    <Icon name="folder" size={14} />
                    {t('teamProjects.openProject')}
                  </Button>
                  {project.visibility === 'personal' ? (
                    <Button
                      type="button"
                      variant="primary-ghost"
                      onClick={() => void moveProject(project, 'team')}
                      disabled={!canMoveToTeam || moving}
                    >
                      <Icon name={moving ? 'spinner' : 'share'} size={14} />
                      {t('teamProjects.moveToTeam')}
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => void moveProject(project, 'personal')}
                      disabled={!canMoveToPersonal || moving}
                    >
                      <Icon name={moving ? 'spinner' : 'file'} size={14} />
                      {t('teamProjects.moveToPersonal')}
                    </Button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}

function syncLabel(syncState: WorkspaceProjectSummary['syncState'], t: ReturnType<typeof useT>): string {
  if (syncState === 'pending_upload') return t('teamProjects.syncPending');
  if (syncState === 'synced') return t('teamProjects.syncSynced');
  if (syncState === 'sync_failed') return t('teamProjects.syncFailed');
  if (syncState === 'remote_deleted') return t('teamProjects.syncRemoteDeleted');
  return t('teamProjects.syncLocalOnly');
}

function projectKindLabel(project: WorkspaceProjectSummary, t: ReturnType<typeof useT>): string {
  const kind = project.metadata?.kind;
  if (kind === 'deck') return t('designs.tagSlide');
  if (kind === 'brand') return 'Brand';
  if (kind === 'image' || kind === 'video' || kind === 'audio') return t('designs.tagMedia');
  return t('designs.tagPrototype');
}

function relativeTime(ts: number, t: ReturnType<typeof useT>): string {
  const diff = Math.max(0, Date.now() - ts);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return t('common.justNow');
  if (diff < hour) return t('common.minutesAgo', { n: Math.floor(diff / minute) });
  if (diff < day) return t('common.hoursAgo', { n: Math.floor(diff / hour) });
  if (diff < 7 * day) return t('common.daysAgo', { n: Math.floor(diff / day) });
  return new Date(ts).toLocaleDateString();
}
