import type { CollabMemberRole } from '@open-design/contracts';

// Settings shell role gating (E-frontend, D4.3). The current SettingsDialog
// renders every section unconditionally; this is the new layer that shows the
// *workspace* sections by role. E (our lane) owns ONLY the shell-level
// visibility — the section internals belong to their lanes: members = B,
// billing = A, team-space = D. Personal settings are always shown and are not
// modeled here. Role comes from the foundation context (B's member role).
//
// Note (D4.3): there is no team-level BYOK/provider this cycle, so "member can't
// edit the workspace provider" has no object — the sections that actually need
// gating are these other-lane workspace entries.

export type WorkspaceSettingsSection = 'members' | 'billing' | 'team-space';

export const WORKSPACE_SETTINGS_SECTIONS: readonly WorkspaceSettingsSection[] = [
  'members',
  'billing',
  'team-space',
];

// Which roles may see each workspace section. Billing is owner-only (the billing
// owner); membership + team-space management are owner/admin.
const SECTION_VISIBILITY: Record<WorkspaceSettingsSection, ReadonlySet<CollabMemberRole>> = {
  members: new Set(['owner', 'admin']),
  billing: new Set(['owner']),
  'team-space': new Set(['owner', 'admin']),
};

/** Whether the Settings shell shows a given workspace section for this role. */
export function canSeeWorkspaceSettingsSection(
  role: CollabMemberRole | null | undefined,
  section: WorkspaceSettingsSection,
): boolean {
  if (!role) return false; // no team context → no workspace sections at all
  return SECTION_VISIBILITY[section].has(role);
}

/** The workspace settings sections the shell renders for this role (in order). */
export function workspaceSettingsSectionsForRole(
  role: CollabMemberRole | null | undefined,
): WorkspaceSettingsSection[] {
  return WORKSPACE_SETTINGS_SECTIONS.filter((section) => canSeeWorkspaceSettingsSection(role, section));
}
