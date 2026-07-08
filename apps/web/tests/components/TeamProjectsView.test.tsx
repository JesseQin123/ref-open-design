// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceCollabContext } from '@open-design/contracts';

import { TeamProjectsView } from '../../src/components/TeamProjectsView';
import { I18nProvider } from '../../src/i18n';
import type { WorkspaceProjectSummary } from '../../src/state/workspace-projects';

const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function context(): WorkspaceCollabContext {
  return {
    workspaceId: 'ws-1',
    workspaceType: 'team',
    workspaceMemberId: 'member-1',
    role: 'member',
    memberStatus: 'active',
    lifecycleState: 'active',
    billingState: 'active',
    planId: 'team',
    providerMode: 'platform_credits',
    seatSummary: {
      seatLimit: 10,
      usedSeats: 2,
      availableSeats: 8,
      isSeatFull: false,
    },
    permissions: {
      canManageMembers: false,
      canManageBilling: false,
      canInviteMembers: false,
      canManageAutoRecharge: false,
      canShareProjects: true,
      canWriteSyncedFiles: true,
      canViewWorkspaceSettings: true,
      canManageSharedResources: false,
    },
  };
}

function workspaceProject(
  overrides: Partial<WorkspaceProjectSummary> = {},
): WorkspaceProjectSummary {
  const now = Date.now();
  return {
    id: 'project-1',
    name: 'Landing refresh',
    workspaceId: 'ws-1',
    visibility: 'personal',
    resourceState: 'active',
    createdByWorkspaceMemberId: 'member-1',
    updatedByWorkspaceMemberId: 'member-1',
    resourceHubResourceId: null,
    cloudTombstonedAt: null,
    currentUserAccess: {
      canOpen: true,
      canRename: true,
      canDelete: true,
      canDuplicate: true,
      canMoveToTeam: true,
      canMoveToPersonal: false,
      canExport: true,
      canSendTo: true,
      canRestoreVersion: true,
    },
    syncState: 'local_only',
    createdAt: now - 60_000,
    updatedAt: now - 60_000,
    metadata: { kind: 'prototype' },
    project: {
      id: 'project-1',
      name: 'Landing refresh',
      skillId: null,
      designSystemId: null,
      createdAt: now - 60_000,
      updatedAt: now - 60_000,
      metadata: { kind: 'prototype' },
    },
    ...overrides,
  };
}

function renderView(mode: 'drafts' | 'all-projects' = 'all-projects') {
  render(
    <I18nProvider initial="en">
      <TeamProjectsView mode={mode} context={context()} onOpenProject={vi.fn()} />
    </I18nProvider>,
  );

  expect(globalThis.fetch).toHaveBeenCalledWith('/api/workspaces/ws-1/projects?view=all');
}

describe('TeamProjectsView', () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
  });

  it('shows team visibility as a shared badge in all projects', async () => {
    const shared = workspaceProject({
      visibility: 'team',
      syncState: 'synced',
      currentUserAccess: {
        ...workspaceProject().currentUserAccess,
        canMoveToTeam: false,
        canMoveToPersonal: true,
      },
    });
    vi.mocked(globalThis.fetch).mockResolvedValue(jsonResponse({ projects: [shared] }));

    renderView();

    expect(await screen.findByText('Landing refresh')).toBeTruthy();
    expect(screen.getByText('Team')).toBeTruthy();
    expect(screen.getByText('Shared')).toBeTruthy();
    expect(screen.getByText('Synced')).toBeTruthy();
  });

  it('moves a personal project to team visibility', async () => {
    const personal = workspaceProject();
    const shared = workspaceProject({
      visibility: 'team',
      syncState: 'pending_upload',
      currentUserAccess: {
        ...personal.currentUserAccess,
        canMoveToTeam: false,
        canMoveToPersonal: true,
      },
    });
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(jsonResponse({ projects: [personal] }))
      .mockResolvedValueOnce(jsonResponse({ project: shared }));

    renderView();

    fireEvent.click(await screen.findByRole('button', { name: /share to team/i }));

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenLastCalledWith(
        '/api/workspaces/ws-1/projects/project-1/move',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ visibility: 'team' }),
        }),
      );
    });
    expect(await screen.findByText('Shared')).toBeTruthy();
    expect(screen.getByText('Sync pending')).toBeTruthy();
  });
});
