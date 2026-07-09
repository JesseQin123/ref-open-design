// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommunityView } from '../src/components/CommunityView';

afterEach(cleanup);

describe('CommunityView remix', () => {
  it('threads the chosen template id + a starting prompt into onRemixTemplate', () => {
    // The primary "Remix" CTA must not drop the selected template: it hands the
    // template id AND a Home-composer starting prompt to the caller, which seeds
    // Home instead of navigating to a generic page.
    const onRemix = vi.fn();
    render(<CommunityView onRemixTemplate={onRemix} />);

    // The default view (Slides) shows non-prompt cards whose action reads "Remix".
    const remixButtons = screen.getAllByRole('button', { name: 'Remix' });
    expect(remixButtons.length).toBeGreaterThan(0);
    fireEvent.click(remixButtons[0]!);

    expect(onRemix).toHaveBeenCalledTimes(1);
    const arg = onRemix.mock.calls[0]![0] as { templateId: string; prompt: string };
    expect(typeof arg.templateId).toBe('string');
    expect(arg.templateId.length).toBeGreaterThan(0);
    // The prompt is template-specific, not a generic fallback.
    expect(arg.prompt).toMatch(/^Remix the ".+" community template into a new Open Design project/);
  });
});
