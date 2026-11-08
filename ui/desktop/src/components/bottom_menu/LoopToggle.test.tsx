import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../../i18n/test-utils';
import { LoopToggle } from './LoopToggle';

const mockGetItem = vi.fn();
const mockSetGrind = vi.fn();

vi.mock('../../acp/sessions', () => ({
  acpGetSessionListItem: (...args: unknown[]) => mockGetItem(...args),
  acpSetSessionGrind: (...args: unknown[]) => mockSetGrind(...args),
}));

// Render the menu flat so its content is always on screen.
vi.mock('../ui/dropdown-menu', () => ({
  DropdownMenu: ({
    children,
    onOpenChange,
  }: {
    children: React.ReactNode;
    onOpenChange: (open: boolean) => void;
  }) => (
    <div>
      <button onClick={() => onOpenChange(true)}>Open loop menu</button>
      {children}
    </div>
  ),
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const renderToggle = (isLoading: boolean, onStartIdle = vi.fn()) =>
  render(<LoopToggle sessionId="s1" isLoading={isLoading} onStartIdle={onStartIdle} />, {
    wrapper: IntlTestWrapper,
  });

describe('LoopToggle', () => {
  beforeEach(() => {
    mockGetItem.mockReset();
    mockSetGrind.mockReset().mockResolvedValue(undefined);
    localStorage.clear();
  });

  it('shows the session loop state', async () => {
    mockGetItem.mockResolvedValue({ grind: 'convert everything' });
    renderToggle(false);
    expect(await screen.findByText('Loop On')).toBeInTheDocument();
  });

  it('starts an idle session through the /grind turn', async () => {
    mockGetItem.mockResolvedValue({});
    const onStartIdle = vi.fn();
    renderToggle(false, onStartIdle);
    expect(await screen.findByText('Loop Off')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Open loop menu'));
    fireEvent.change(screen.getByTestId('loop-goal'), { target: { value: '  keep going  ' } });
    fireEvent.click(screen.getByTestId('loop-start'));

    await waitFor(() => expect(onStartIdle).toHaveBeenCalledWith('keep going'));
    expect(mockSetGrind).not.toHaveBeenCalled();
    expect(await screen.findByText('Loop On')).toBeInTheDocument();
  });

  it('starts mid-turn without a chat message, and remembers the goal', async () => {
    mockGetItem.mockResolvedValue({});
    const onStartIdle = vi.fn();
    renderToggle(true, onStartIdle);

    fireEvent.click(screen.getByText('Open loop menu'));
    fireEvent.change(screen.getByTestId('loop-goal'), { target: { value: 'keep going' } });
    fireEvent.click(screen.getByTestId('loop-start'));

    await waitFor(() => expect(mockSetGrind).toHaveBeenCalledWith('s1', 'keep going'));
    expect(onStartIdle).not.toHaveBeenCalled();
    expect(localStorage.getItem('goose.loop.lastGoal.s1')).toBe('keep going');
  });

  it('stops the loop without a chat message', async () => {
    mockGetItem.mockResolvedValue({ grind: 'convert everything' });
    renderToggle(true);
    expect(await screen.findByText('Loop On')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('loop-stop'));

    await waitFor(() => expect(mockSetGrind).toHaveBeenCalledWith('s1', null));
    expect(await screen.findByText('Loop Off')).toBeInTheDocument();
  });
});
