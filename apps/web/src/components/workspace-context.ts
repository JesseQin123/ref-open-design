import type { WorkspaceContextItem } from '@open-design/contracts';

export function workspaceContextLinkedDir(item: WorkspaceContextItem): string | null {
  if (item.kind !== 'local-code' && item.kind !== 'project') return null;
  const dir = item.absolutePath?.trim();
  return dir || null;
}

export function workspaceContextLinkedDirs(items: WorkspaceContextItem[]): string[] {
  const dirs = items
    .map(workspaceContextLinkedDir)
    .filter((dir): dir is string => Boolean(dir));
  return Array.from(new Set(dirs));
}
