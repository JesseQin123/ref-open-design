import type http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startServer } from '../../src/server.js';

describe('workspace project routes', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    const started = (await startServer({ port: 0, returnServer: true })) as {
      url: string;
      server: http.Server;
    };
    baseUrl = started.url;
    server = started.server;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const workspaceId = `ws-${Date.now()}`;

  function headers(memberId: string, extra: Record<string, string> = {}) {
    return {
      'content-type': 'application/json',
      'x-od-workspace-id': workspaceId,
      'x-od-workspace-member-id': memberId,
      'x-od-workspace-role': 'member',
      ...extra,
    };
  }

  async function createProject(id: string, name: string) {
    const resp = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, name, skillId: null, designSystemId: null }),
    });
    expect(resp.status).toBe(200);
  }

  async function list(memberId: string, query = '') {
    const resp = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/projects${query}`, {
      headers: headers(memberId),
    });
    if (resp.status !== 200) {
      throw new Error(`GET workspace projects failed ${resp.status}: ${await resp.text()}`);
    }
    return resp.json() as Promise<{ projects: Array<any> }>;
  }

  it('projects legacy rows into a workspace list with self-created ownership', async () => {
    const projectId = `workspace-list-${Date.now()}`;
    await createProject(projectId, 'Workspace list fixture');

    const body = await list('member-list', '?view=all');

    const project = body.projects.find((item) => item.id === projectId);
    expect(project).toMatchObject({
      id: projectId,
      visibility: 'personal',
      resourceState: 'active',
      createdByWorkspaceMemberId: 'member-list',
    });
    expect(project.currentUserAccess.canDelete).toBe(true);
  });

  it('projects legacy rows for batch operations without requiring a prior list request', async () => {
    const suffix = Date.now();
    const moveProjectId = `workspace-batch-move-${suffix}`;
    const deleteProjectId = `workspace-batch-delete-${suffix}`;
    await createProject(moveProjectId, 'Direct batch move project');
    await createProject(deleteProjectId, 'Direct batch delete project');

    const moveResp = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/projects/batch-move`, {
      method: 'POST',
      headers: headers('member-direct'),
      body: JSON.stringify({ projectIds: [moveProjectId], visibility: 'team' }),
    });
    expect(moveResp.status).toBe(200);
    const moved = await moveResp.json() as { projects: Array<any> };
    expect(moved.projects[0]).toMatchObject({
      id: moveProjectId,
      visibility: 'team',
      syncState: 'pending_upload',
      resourceHubResourceId: null,
      cloudTombstonedAt: null,
      createdByWorkspaceMemberId: 'member-direct',
      pendingSyncIntent: {
        event: 'project_team_share_requested',
        projectId: moveProjectId,
        workspaceId,
      },
    });
    const batchShareStatus = await fetch(`${baseUrl}/api/projects/${moveProjectId}/collab/status`);
    expect(batchShareStatus.status).toBe(200);
    const batchShare = await batchShareStatus.json() as { syncState: string; ownerMemberId: string | null };
    expect(['pending_upload', 'synced']).toContain(batchShare.syncState);
    expect(batchShare.ownerMemberId).toBe('member-direct');

    const moveBackResp = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/projects/${moveProjectId}/move`, {
      method: 'POST',
      headers: headers('member-direct'),
      body: JSON.stringify({ visibility: 'personal' }),
    });
    expect(moveBackResp.status).toBe(200);
    const movedBack = await moveBackResp.json() as { project: any };
    expect(movedBack.project).toMatchObject({
      id: moveProjectId,
      visibility: 'personal',
      syncState: 'local_only',
      resourceHubResourceId: null,
    });
    expect(typeof movedBack.project.cloudTombstonedAt).toBe('number');

    const deleteResp = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/projects/batch-delete`, {
      method: 'POST',
      headers: headers('member-direct'),
      body: JSON.stringify({ projectIds: [deleteProjectId] }),
    });
    expect(deleteResp.status).toBe(200);

    const deleted = await fetch(`${baseUrl}/api/projects/${deleteProjectId}`);
    expect(deleted.status).toBe(404);
  });

  it('rejects mixed member batch-delete all-or-nothing and deletes self-created selections', async () => {
    const suffix = Date.now();
    const selfProjectId = `workspace-delete-self-${suffix}`;
    const otherProjectId = `workspace-delete-other-${suffix}`;
    await createProject(selfProjectId, 'Self project');
    await list('member-a');
    await createProject(otherProjectId, 'Other project');
    await list('member-b');

    const mixedResp = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/projects/batch-delete`, {
      method: 'POST',
      headers: headers('member-a'),
      body: JSON.stringify({ projectIds: [selfProjectId, otherProjectId] }),
    });
    expect(mixedResp.status).toBe(403);

    const selfStillExists = await fetch(`${baseUrl}/api/projects/${selfProjectId}`);
    const otherStillExists = await fetch(`${baseUrl}/api/projects/${otherProjectId}`);
    expect(selfStillExists.status).toBe(200);
    expect(otherStillExists.status).toBe(200);

    const selfOnlyResp = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/projects/batch-delete`, {
      method: 'POST',
      headers: headers('member-a'),
      body: JSON.stringify({ projectIds: [selfProjectId] }),
    });
    expect(selfOnlyResp.status).toBe(200);
    const deleted = await selfOnlyResp.json() as { deletedProjectIds: string[] };
    expect(deleted.deletedProjectIds).toEqual([selfProjectId]);

    const selfGone = await fetch(`${baseUrl}/api/projects/${selfProjectId}`);
    const otherRemains = await fetch(`${baseUrl}/api/projects/${otherProjectId}`);
    expect(selfGone.status).toBe(404);
    expect(otherRemains.status).toBe(200);
  });

  it('blocks moving frozen team projects back to personal', async () => {
    const projectId = `workspace-frozen-${Date.now()}`;
    await createProject(projectId, 'Frozen project');
    await list('member-frozen');

    const moveToTeam = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/projects/${projectId}/move`, {
      method: 'POST',
      headers: headers('member-frozen'),
      body: JSON.stringify({ visibility: 'team' }),
    });
    expect(moveToTeam.status).toBe(200);
    const shareStatus = await fetch(`${baseUrl}/api/projects/${projectId}/collab/status`);
    expect(shareStatus.status).toBe(200);
    const share = await shareStatus.json() as { syncState: string; ownerMemberId: string | null };
    expect(['pending_upload', 'synced']).toContain(share.syncState);
    expect(share.ownerMemberId).toBe('member-frozen');

    const lockedList = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/projects?view=team`, {
      headers: headers('member-frozen', { 'x-od-workspace-lifecycle-state': 'locked' }),
    });
    expect(lockedList.status).toBe(200);
    const lockedBody = await lockedList.json() as { projects: Array<any> };
    const frozen = lockedBody.projects.find((item: any) => item.id === projectId);
    expect(frozen.resourceState).toBe('frozen');
    expect(frozen.currentUserAccess.canMoveToPersonal).toBe(false);
    expect(frozen.currentUserAccess.canDuplicate).toBe(false);

    const moveToPersonal = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/projects/${projectId}/move`, {
      method: 'POST',
      headers: headers('member-frozen', { 'x-od-workspace-lifecycle-state': 'locked' }),
      body: JSON.stringify({ visibility: 'personal' }),
    });
    expect(moveToPersonal.status).toBe(403);
  });

  it('honors workspace permission bits when sharing personal projects', async () => {
    const projectId = `workspace-share-permission-${Date.now()}`;
    await createProject(projectId, 'Share permission project');

    const body = await list('member-share-permission', '?view=personal');
    const project = body.projects.find((item: any) => item.id === projectId);
    expect(project.currentUserAccess.canRename).toBe(true);
    expect(project.currentUserAccess.canMoveToTeam).toBe(true);

    const restrictedList = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/projects?view=personal`, {
      headers: headers('member-share-permission', { 'x-od-workspace-can-share-projects': 'false' }),
    });
    expect(restrictedList.status).toBe(200);
    const restrictedBody = await restrictedList.json() as { projects: Array<any> };
    const restrictedProject = restrictedBody.projects.find((item: any) => item.id === projectId);
    expect(restrictedProject.currentUserAccess.canRename).toBe(true);
    expect(restrictedProject.currentUserAccess.canMoveToTeam).toBe(false);

    const moveResp = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/projects/${projectId}/move`, {
      method: 'POST',
      headers: headers('member-share-permission', { 'x-od-workspace-can-share-projects': 'false' }),
      body: JSON.stringify({ visibility: 'team' }),
    });
    expect(moveResp.status).toBe(403);
  });
});
