import type { Project } from '../types';

export type WorkspaceProjectVisibility = 'personal' | 'team';
export type WorkspaceProjectSyncState =
  | 'local_only'
  | 'pending_upload'
  | 'synced'
  | 'sync_failed'
  | 'remote_deleted';

export interface WorkspaceProjectAccess {
  canOpen: boolean;
  canRename: boolean;
  canDelete: boolean;
  canDuplicate: boolean;
  canMoveToTeam: boolean;
  canMoveToPersonal: boolean;
  canExport: boolean;
  canSendTo: boolean;
  canRestoreVersion: boolean;
  disabledReason?: string;
}

export interface WorkspaceProjectSummary {
  id: string;
  name: string;
  workspaceId: string;
  visibility: WorkspaceProjectVisibility;
  resourceState: 'active' | 'frozen' | 'deleted';
  createdByWorkspaceMemberId: string | null;
  updatedByWorkspaceMemberId: string | null;
  resourceHubResourceId: string | null;
  cloudTombstonedAt: number | null;
  currentUserAccess: WorkspaceProjectAccess;
  syncState: WorkspaceProjectSyncState;
  createdAt: number;
  updatedAt: number;
  metadata?: Project['metadata'];
  project: Project;
}

export interface WorkspaceProjectsResponse {
  projects: WorkspaceProjectSummary[];
}

export async function listWorkspaceProjects(input: {
  workspaceId: string;
  view?: 'all' | 'drafts' | 'team';
  owner?: 'all' | 'mine' | 'others';
  visibility?: 'all' | WorkspaceProjectVisibility;
}): Promise<WorkspaceProjectSummary[]> {
  const params = new URLSearchParams();
  if (input.view) params.set('view', input.view);
  if (input.owner) params.set('owner', input.owner);
  if (input.visibility) params.set('visibility', input.visibility);

  const query = params.toString();
  const resp = await fetch(
    `/api/workspaces/${encodeURIComponent(input.workspaceId)}/projects${query ? `?${query}` : ''}`,
  );
  if (!resp.ok) throw new Error(`workspace projects ${resp.status}`);
  const body = (await resp.json()) as WorkspaceProjectsResponse;
  return Array.isArray(body.projects) ? body.projects : [];
}

export async function moveWorkspaceProject(input: {
  workspaceId: string;
  projectId: string;
  visibility: WorkspaceProjectVisibility;
}): Promise<WorkspaceProjectSummary> {
  const resp = await fetch(
    `/api/workspaces/${encodeURIComponent(input.workspaceId)}/projects/${encodeURIComponent(input.projectId)}/move`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visibility: input.visibility }),
    },
  );
  if (!resp.ok) throw new Error(`workspace project move ${resp.status}`);
  const body = (await resp.json()) as { project?: WorkspaceProjectSummary };
  if (!body.project) throw new Error('workspace project move returned no project');
  return body.project;
}
