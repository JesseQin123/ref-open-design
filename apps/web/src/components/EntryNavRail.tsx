// Two-state entry navigation rail.
//
// The rail renders one of two shells driven entirely by the real workspace
// context (`GET /api/workspace/context`, shared via `useWorkspaceContext`):
//
//   • Team state  — context is non-null AND workspaceType === 'team':
//       workspace switcher + plan chip, search, recents, Community, and a team
//       section (drafts / all projects / design systems / plugins / members /
//       board / workspace settings). Team destinations are permission-gated and
//       their views are provided by other lanes (rendered as placeholders here).
//   • Local state — no context OR workspaceType === 'personal':
//       a trimmed rail (search, recents, Community, design systems, plugins) plus
//       a "sign in to the cloud" callout that leads to the team flow.
//
// The gate is deliberately NOT `providerMode`: a BYOK / non-AMR workspace still
// has full team features, so the shell keys off `workspaceType` + permissions,
// never the billing/provider axis.

import { useEffect, useRef, type ReactNode } from 'react';
import {
  isWorkspaceLifecycleWritable,
  type WorkspaceCollabContext,
} from '@open-design/contracts';
import { EntryHelpMenu } from './EntryHelpMenu';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';
import { Icon } from './Icon';
import { useT } from '../i18n';
import type { EntryHomeView } from '../router';
import styles from './EntryNavRail.module.css';

const externalLinkProps = { target: '_blank', rel: 'noreferrer noopener' } as const;

// The rail's destination ids are the entry-shell home views (kept in sync with
// the router so `navigate({ kind: 'home', view })` type-checks for every item).
export type EntryView = EntryHomeView;

interface Props {
  view: EntryView;
  onViewChange: (view: EntryView) => void;
  onNewProject: () => void;
  newProjectDisabled?: boolean;
  /** When false the rail is collapsed (hidden off-canvas) on the entry view. */
  open: boolean;
  /** Collapse the rail — called after the user dismisses it. */
  onClose: () => void;
  /** The one shared workspace context; null → local (non-team) state. */
  context: WorkspaceCollabContext | null;
  /** Open the app settings dialog. */
  onOpenSettings?: () => void;
  /** Open the members / invite slot (B's InviteDialog). */
  onInvite?: () => void;
  /** Start the cloud sign-in / team flow from the local-state callout. */
  onSignInCloud?: () => void;
}

interface NavButtonProps {
  active?: boolean;
  ariaLabel: string;
  tooltip: string;
  onClick: () => void;
  disabled?: boolean;
  testId?: string;
  children: ReactNode;
}

function NavButton({ active, ariaLabel, tooltip, onClick, disabled, testId, children }: NavButtonProps) {
  return (
    <button
      type="button"
      className={`entry-nav-rail__btn${active ? ' is-active' : ''}`}
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      aria-current={active ? 'page' : undefined}
      data-tooltip={tooltip}
      {...(testId ? { 'data-testid': testId } : {})}
    >
      <span className="entry-nav-rail__btn-icon" aria-hidden>{children}</span>
      <span className="entry-nav-rail__btn-label">{tooltip}</span>
    </button>
  );
}

export function EntryNavRail({
  view,
  onViewChange,
  onNewProject,
  newProjectDisabled = false,
  open,
  onClose,
  context,
  onOpenSettings,
  onInvite,
  onSignInCloud,
}: Props) {
  const t = useT();
  const brandLabel = t('app.brand');
  const homeLabel = t('entry.navHome');
  const communityLabel = t('pluginsHome.title');
  const isHome = view === 'home';

  const isTeam = Boolean(context) && context!.workspaceType === 'team';
  const permissions = context?.permissions;
  const writable = context ? isWorkspaceLifecycleWritable(context.lifecycleState) : true;
  const locked = context?.lifecycleState === 'locked';
  const billingRecovery = context?.billingRecovery;
  // Team management (members, dashboard, billing) lives in the cloud web console,
  // not the local client — the rail links out to it through the one workspace
  // settings entry. `canViewWorkspaceSettings` gates that link (a read action, so
  // it stays visible when locked); never re-derive from role — the permission
  // bits already fold role + lifecycle in.
  const canSeeWorkspaceSettings = Boolean(permissions?.canViewWorkspaceSettings);
  const canManageBilling = Boolean(permissions?.canManageBilling);
  const workspaceSettingsUrl = context?.workspaceSettingsUrl?.trim() || null;
  const planLabel = context?.planId?.trim() || null;

  const selectView = (next: EntryView) => {
    onViewChange(next);
  };

  // While collapsed the rail is visually hidden but its controls stay mounted;
  // mark it `inert` so they leave the tab order and pointer flow entirely.
  const railRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const node = railRef.current;
    if (!node) return;
    if (open) {
      node.removeAttribute('inert');
    } else {
      node.setAttribute('inert', '');
    }
  }, [open]);

  return (
    <nav
      ref={railRef}
      className={`entry-nav-rail${open ? ' is-open' : ''}`}
      aria-label="Primary"
      aria-hidden={open ? undefined : true}
    >
      <div className="entry-nav-rail__group">
        <div className="entry-nav-rail__brand">
          <button
            type="button"
            className="entry-nav-rail__logo"
            onClick={() => selectView('home')}
            aria-label={brandLabel}
            data-testid="entry-nav-logo"
          >
            <img
              src="/app-icon.svg"
              alt=""
              className="entry-nav-rail__logo-img"
              draggable={false}
            />
          </button>
          <button
            type="button"
            className="entry-nav-rail__collapse"
            onClick={onClose}
            aria-label={t('entry.navCollapse')}
            title={t('entry.navCollapse')}
            data-testid="entry-nav-collapse"
          >
            <Icon name="panel-left" size={20} />
          </button>
        </div>
        <div className="entry-nav-rail__logo-divider" role="separator" aria-hidden="true" />

        {isTeam ? (
          <div className={styles.workspace}>
            <div className={styles.workspaceRow}>
              <WorkspaceSwitcher context={context} onInvite={onInvite} />
            </div>
            {planLabel ? (
              // Billing/upgrade is managed in the cloud console — the chip links
              // out there rather than opening an in-client settings view.
              <button
                type="button"
                className={`${styles.planChip}${canManageBilling && workspaceSettingsUrl ? ` ${styles.clickable}` : ''}`}
                onClick={
                  canManageBilling && workspaceSettingsUrl
                    ? () => window.open(workspaceSettingsUrl, '_blank', 'noopener,noreferrer')
                    : undefined
                }
                disabled={!(canManageBilling && workspaceSettingsUrl)}
                aria-label={t('entry.workspaceTeamsLabel')}
                data-testid="entry-nav-plan-chip"
              >
                <Icon name="sparkles" size={12} />
                {planLabel}
                {canManageBilling && workspaceSettingsUrl ? <span aria-hidden>· {t('settings.amrUpgrade')}</span> : null}
              </button>
            ) : null}
          </div>
        ) : null}

        <div className={styles.search} aria-hidden>
          <Icon name="search" size={14} />
          <input type="text" placeholder={t('common.search')} readOnly tabIndex={-1} />
        </div>

        <NavButton
          ariaLabel={t('entry.navNewProject')}
          tooltip={t('entry.navNewProject')}
          onClick={onNewProject}
          disabled={newProjectDisabled || (isTeam && !writable)}
          testId="entry-nav-new-project"
        >
          <Icon name="plus" size={18} />
        </NavButton>
        <NavButton
          active={isHome}
          ariaLabel={homeLabel}
          tooltip={homeLabel}
          onClick={() => selectView('home')}
          testId="entry-nav-home"
        >
          <Icon name="home" size={18} />
        </NavButton>
        <NavButton
          active={view === 'community'}
          ariaLabel={communityLabel}
          tooltip={communityLabel}
          onClick={() => selectView('community')}
          testId="entry-nav-community"
        >
          <Icon name="globe" size={18} />
        </NavButton>

        {isTeam ? (
          <>
            {locked ? (
              <div className={styles.locked} data-testid="entry-nav-locked-banner">
                <div className={styles.lockedHead}>
                  <Icon name="alert-triangle" size={14} />
                  {t('entry.workspaceLockedNote')}
                </div>
                {billingRecovery?.canEnterBillingRecovery && billingRecovery.recoveryUrl ? (
                  <a
                    className={styles.lockedAction}
                    href={billingRecovery.recoveryUrl}
                    {...externalLinkProps}
                    data-testid="entry-nav-locked-recover"
                  >
                    {t('entry.workspaceLockedRecover')}
                  </a>
                ) : null}
              </div>
            ) : null}
            <div className={styles.sectionLabel}>{t('entry.navTeamSection')}</div>
            <NavButton
              active={view === 'drafts'}
              ariaLabel={t('entry.navDrafts')}
              tooltip={t('entry.navDrafts')}
              onClick={() => selectView('drafts')}
              testId="entry-nav-drafts"
            >
              <Icon name="file" size={18} />
            </NavButton>
            <NavButton
              active={view === 'all-projects'}
              ariaLabel={t('entry.navAllProjects')}
              tooltip={t('entry.navAllProjects')}
              onClick={() => selectView('all-projects')}
              testId="entry-nav-all-projects"
            >
              <Icon name="folder" size={18} />
            </NavButton>
            <NavButton
              active={view === 'design-systems'}
              ariaLabel={t('entry.navDesignSystems')}
              tooltip={t('entry.navDesignSystems')}
              onClick={() => selectView('design-systems')}
              testId="entry-nav-design-systems"
            >
              <Icon name="palette" size={18} />
            </NavButton>
            <NavButton
              active={view === 'plugins'}
              ariaLabel={t('entry.navPlugins')}
              tooltip={t('entry.navPlugins')}
              onClick={() => selectView('plugins')}
              testId="entry-nav-plugins"
            >
              <Icon name="grid" size={18} />
            </NavButton>
            {/* Members and the team dashboard live in the cloud web console, not
                the local client. The rail keeps a single Workspace settings entry
                that opens that console in the browser. */}
            {canSeeWorkspaceSettings && workspaceSettingsUrl ? (
              <a
                className="entry-nav-rail__btn"
                href={workspaceSettingsUrl}
                {...externalLinkProps}
                aria-label={t('entry.navWorkspaceSettings')}
                data-tooltip={t('entry.navWorkspaceSettings')}
                data-testid="entry-nav-workspace-settings"
              >
                <span className="entry-nav-rail__btn-icon" aria-hidden>
                  <Icon name="settings" size={18} />
                </span>
                <span className="entry-nav-rail__btn-label">{t('entry.navWorkspaceSettings')}</span>
              </a>
            ) : null}
          </>
        ) : (
          <>
            <NavButton
              active={view === 'projects'}
              ariaLabel={t('entry.navProjects')}
              tooltip={t('entry.navProjects')}
              onClick={() => selectView('projects')}
              testId="entry-nav-projects"
            >
              <Icon name="folder" size={18} />
            </NavButton>
            <NavButton
              active={view === 'tasks'}
              ariaLabel={t('entry.navTasks')}
              tooltip={t('entry.navTasks')}
              onClick={() => selectView('tasks')}
              testId="entry-nav-tasks"
            >
              <Icon name="check" size={18} />
            </NavButton>
            <div className={styles.divider} aria-hidden />
            <NavButton
              active={view === 'design-systems'}
              ariaLabel={t('entry.navDesignSystems')}
              tooltip={t('entry.navDesignSystems')}
              onClick={() => selectView('design-systems')}
              testId="entry-nav-design-systems"
            >
              <Icon name="palette" size={18} />
            </NavButton>
            <NavButton
              active={view === 'plugins'}
              ariaLabel={t('entry.navPlugins')}
              tooltip={t('entry.navPlugins')}
              onClick={() => selectView('plugins')}
              testId="entry-nav-plugins"
            >
              <Icon name="grid" size={18} />
            </NavButton>
            <NavButton
              active={view === 'integrations'}
              ariaLabel={t('entry.navIntegrations')}
              tooltip={t('entry.navIntegrations')}
              onClick={() => selectView('integrations')}
              testId="entry-nav-integrations"
            >
              <Icon name="integrations-filled" size={18} />
            </NavButton>
            <button
              type="button"
              className={styles.callout}
              onClick={() => onSignInCloud?.()}
              data-testid="entry-nav-cloud-callout"
            >
              <span className={styles.calloutHead}>
                <span className={styles.calloutIcon} aria-hidden>
                  <Icon name="sparkles" size={14} />
                </span>
                {t('entry.cloudCalloutTitle')}
              </span>
              <span className={styles.calloutBody}>{t('entry.cloudCalloutBody')}</span>
            </button>
          </>
        )}
      </div>
      <div className="entry-nav-rail__footer">
        {onOpenSettings ? (
          <div className={styles.social}>
            <button
              type="button"
              className={styles.socialLink}
              onClick={() => onOpenSettings()}
              aria-label={t('entry.openSettingsAria')}
              data-tooltip={t('entry.openSettingsTitle')}
              data-testid="entry-nav-settings"
            >
              <Icon name="settings" size={15} />
            </button>
          </div>
        ) : null}
        <div className="entry-nav-rail__divider" role="separator" />
        <EntryHelpMenu />
      </div>
    </nav>
  );
}
