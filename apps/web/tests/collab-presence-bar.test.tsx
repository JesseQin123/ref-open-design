// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { PresenceBar } from '../src/collab/PresenceBar.js';

afterEach(cleanup);

describe('PresenceBar', () => {
  it('renders initials for present members and excludes self', () => {
    render(
      <PresenceBar
        selfMemberId="me"
        members={[
          { memberId: 'me', name: 'Me' },
          { memberId: 'm1', name: 'Ma Shu', role: 'member' },
          { memberId: 'm2', name: 'Yuan Xi', role: 'admin' },
        ]}
      />,
    );
    expect(screen.getByText('MS')).toBeTruthy();
    expect(screen.getByText('YX')).toBeTruthy();
    // Self is excluded.
    expect(screen.queryByText('ME')).toBeNull();
    expect(screen.getByRole('group').getAttribute('aria-label')).toContain('2 collaborators');
  });

  it('collapses past the max into a +N overflow chip', () => {
    render(
      <PresenceBar
        max={2}
        members={[
          { memberId: 'a', name: 'Aa' },
          { memberId: 'b', name: 'Bb' },
          { memberId: 'c', name: 'Cc' },
          { memberId: 'd', name: 'Dd' },
        ]}
      />,
    );
    expect(screen.getByText('+2')).toBeTruthy();
  });

  it('renders nothing when only self is present', () => {
    const { container } = render(
      <PresenceBar selfMemberId="me" members={[{ memberId: 'me', name: 'Me' }]} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('falls back to the member id when there is no name', () => {
    render(<PresenceBar members={[{ memberId: 'zx' }]} />);
    expect(screen.getByText('ZX')).toBeTruthy();
  });
});
