import { Repeat } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { acpGetSessionListItem, acpSetSessionGrind } from '../../acp/sessions';
import { defineMessages, useIntl } from '../../i18n';
import { cn } from '../../utils';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '../ui/dropdown-menu';

const i18n = defineMessages({
  loop: { id: 'loopToggle.loop', defaultMessage: 'Loop' },
  on: { id: 'loopToggle.on', defaultMessage: 'On' },
  off: { id: 'loopToggle.off', defaultMessage: 'Off' },
  goal: { id: 'loopToggle.goal', defaultMessage: 'Loop goal' },
  goalPlaceholder: {
    id: 'loopToggle.goalPlaceholder',
    defaultMessage: 'What the agent keeps working on until you turn the loop off',
  },
  start: { id: 'loopToggle.start', defaultMessage: 'Start loop' },
  stop: { id: 'loopToggle.stop', defaultMessage: 'Stop loop' },
  stopHint: {
    id: 'loopToggle.stopHint',
    defaultMessage: 'Stops at the end of the current turn.',
  },
  failed: { id: 'loopToggle.failed', defaultMessage: 'Could not change the loop' },
});

const LAST_GOAL_KEY = 'goose.loop.lastGoal';

function readLastGoal(sessionId: string): string {
  try {
    return (
      localStorage.getItem(`${LAST_GOAL_KEY}.${sessionId}`) ??
      localStorage.getItem(LAST_GOAL_KEY) ??
      ''
    );
  } catch {
    return '';
  }
}

function saveLastGoal(sessionId: string, goal: string) {
  try {
    localStorage.setItem(`${LAST_GOAL_KEY}.${sessionId}`, goal);
    localStorage.setItem(LAST_GOAL_KEY, goal);
  } catch {
    // Only a convenience; the goal itself lives in the session.
  }
}

interface LoopToggleProps {
  sessionId: string;
  isLoading: boolean;
  /** Starts the loop as a chat turn (the /grind command) when the agent is idle. */
  onStartIdle: (goal: string) => void;
}

/** Loop on/off in the chat bar: the session's /grind goal, switchable even mid-turn. */
export function LoopToggle({ sessionId, isLoading, onStartIdle }: LoopToggleProps) {
  const intl = useIntl();
  const [grind, setGrind] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const item = await acpGetSessionListItem(sessionId);
      setGrind(item.grind ?? null);
    } catch {
      // Leave the last known state; the next turn end refreshes again.
    }
  }, [sessionId]);

  // On opening a session, even mid-turn.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // And whenever a turn ends, so a typed /grind or /grind off shows here too.
  useEffect(() => {
    if (!isLoading) void refresh();
  }, [isLoading, refresh]);

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    setError(null);
    if (next) setDraft(grind ?? readLastGoal(sessionId));
  };

  const start = async () => {
    const goal = draft.trim();
    if (!goal) return;
    saveLastGoal(sessionId, goal);
    setError(null);
    try {
      if (isLoading) {
        // Mid-turn: the loop picks it up when the current turn ends.
        await acpSetSessionGrind(sessionId, goal);
      } else {
        onStartIdle(goal);
      }
      setGrind(goal);
      setOpen(false);
    } catch {
      setError(intl.formatMessage(i18n.failed));
    }
  };

  const stop = async () => {
    setError(null);
    try {
      await acpSetSessionGrind(sessionId, null);
      setGrind(null);
      setOpen(false);
    } catch {
      setError(intl.formatMessage(i18n.failed));
    }
  };

  const on = grind !== null;

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger
        data-testid="loop-toggle"
        className={cn(
          'flex items-center hover:cursor-pointer transition-colors',
          on
            ? 'text-green-600 hover:text-green-700'
            : 'text-text-primary/70 hover:text-text-primary'
        )}
        title={on ? grind : intl.formatMessage(i18n.loop)}
      >
        <Repeat className="mr-1 h-4 w-4 flex-shrink-0" />
        <span className="text-xs">
          {intl.formatMessage(i18n.loop)} {intl.formatMessage(on ? i18n.on : i18n.off)}
        </span>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-96 p-3 text-sm">
        <label className="block text-xs text-text-primary mb-1" htmlFor="loop-goal">
          {intl.formatMessage(i18n.goal)}
        </label>
        <textarea
          id="loop-goal"
          data-testid="loop-goal"
          className="w-full min-h-24 rounded border border-border-primary bg-background-primary p-2 text-sm"
          placeholder={intl.formatMessage(i18n.goalPlaceholder)}
          value={draft}
          readOnly={on}
          onChange={(event) => setDraft(event.target.value)}
          // The menu's typeahead would otherwise eat keystrokes.
          onKeyDown={(event) => event.stopPropagation()}
        />
        {error && <p className="mt-1 text-xs text-red-500">{error}</p>}
        <div className="mt-2 flex items-center justify-between gap-2">
          {on ? (
            <>
              <span className="text-xs text-text-secondary">
                {intl.formatMessage(i18n.stopHint)}
              </span>
              <button
                type="button"
                data-testid="loop-stop"
                className="rounded bg-red-600 px-3 py-1 text-xs text-white hover:bg-red-700"
                onClick={() => void stop()}
              >
                {intl.formatMessage(i18n.stop)}
              </button>
            </>
          ) : (
            <button
              type="button"
              data-testid="loop-start"
              className="ml-auto rounded bg-green-600 px-3 py-1 text-xs text-white hover:bg-green-700 disabled:opacity-50"
              disabled={!draft.trim()}
              onClick={() => void start()}
            >
              {intl.formatMessage(i18n.start)}
            </button>
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
