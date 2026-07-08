import { describe, expect, it } from 'vitest';
import {
  canSeeWorkspaceSettingsSection,
  workspaceSettingsSectionsForRole,
} from '../src/collab/settings-access';

describe('workspace settings role gating (D4.3)', () => {
  it('shows every workspace section to an owner', () => {
    expect(workspaceSettingsSectionsForRole('owner')).toEqual(['members', 'billing', 'team-space']);
  });

  it('hides billing from an admin (owner-only) but keeps members + team-space', () => {
    expect(workspaceSettingsSectionsForRole('admin')).toEqual(['members', 'team-space']);
    expect(canSeeWorkspaceSettingsSection('admin', 'billing')).toBe(false);
  });

  it('hides all workspace management sections from a member', () => {
    expect(workspaceSettingsSectionsForRole('member')).toEqual([]);
  });

  it('shows nothing without a team context', () => {
    expect(workspaceSettingsSectionsForRole(null)).toEqual([]);
    expect(canSeeWorkspaceSettingsSection(undefined, 'members')).toBe(false);
  });
});
