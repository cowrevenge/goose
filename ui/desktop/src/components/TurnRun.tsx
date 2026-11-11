import { memo, useEffect, useState } from 'react';
import { isEqual } from 'lodash';
import { AlertTriangle, Loader2 } from 'lucide-react';
import ToolCallWithResponse from './ToolCallWithResponse';
import FinalOutputLine, { isFinalOutputToolRequest } from './FinalOutputLine';
import { NoteStepRow, RowChevron, ThinkingStepRow, TurnStepRow, useStepLabel } from './TurnStepRow';
import { cn } from '../utils';
import { defineMessages, useIntl } from '../i18n';
import { formatDuration, type Run, type StepKind, type ToolStep } from '../utils/turnGrouping';
import type { NotificationEvent } from '../types/message';
import type { ToolRenderState } from './messageRowContext';

// What a finished run did, one clause per kind of call. The clauses are joined with commas and
// the first one gets its capital: "Ran 3 commands, edited a file".
const did = defineMessages({
  command: {
    id: 'turnRun.did.command',
    defaultMessage: '{count, plural, one {ran a command} other {ran # commands}}',
  },
  read: {
    id: 'turnRun.did.read',
    defaultMessage: '{count, plural, one {read a file} other {read # files}}',
  },
  write: {
    id: 'turnRun.did.write',
    defaultMessage: '{count, plural, one {edited a file} other {edited # files}}',
  },
  search: {
    id: 'turnRun.did.search',
    defaultMessage: '{count, plural, one {searched once} other {searched # times}}',
  },
  list: {
    id: 'turnRun.did.list',
    defaultMessage: '{count, plural, one {listed a folder} other {listed # folders}}',
  },
  fetch: {
    id: 'turnRun.did.fetch',
    defaultMessage: '{count, plural, one {fetched a page} other {fetched # pages}}',
  },
  image: {
    id: 'turnRun.did.image',
    defaultMessage: '{count, plural, one {generated an image} other {generated # images}}',
  },
  agent: {
    id: 'turnRun.did.agent',
    defaultMessage: '{count, plural, one {ran a sub-agent} other {ran # sub-agents}}',
  },
  tool: {
    id: 'turnRun.did.tool',
    defaultMessage: '{count, plural, one {used a tool} other {used # tools}}',
  },
});

// What the run is doing right now, while its turn is still going.
const doing = defineMessages({
  command: { id: 'turnRun.doing.command', defaultMessage: 'Running a command' },
  read: { id: 'turnRun.doing.read', defaultMessage: 'Reading a file' },
  write: { id: 'turnRun.doing.write', defaultMessage: 'Editing a file' },
  search: { id: 'turnRun.doing.search', defaultMessage: 'Searching' },
  list: { id: 'turnRun.doing.list', defaultMessage: 'Listing a folder' },
  fetch: { id: 'turnRun.doing.fetch', defaultMessage: 'Fetching a page' },
  image: { id: 'turnRun.doing.image', defaultMessage: 'Generating an image' },
  agent: { id: 'turnRun.doing.agent', defaultMessage: 'Running a sub-agent' },
  tool: { id: 'turnRun.doing.tool', defaultMessage: 'Using {tool}' },
  thinking: { id: 'turnRun.doing.thinking', defaultMessage: 'Thinking' },
});

const i18n = defineMessages({
  thought: { id: 'turnRun.thought', defaultMessage: 'Thought' },
  failed: { id: 'turnRun.failed', defaultMessage: '{count} failed' },
  waiting: { id: 'turnRun.waiting', defaultMessage: 'Waiting for you' },
});

/**
 * A call that is still asking the user: it waits for approval and the turn is not at work, so
 * the user has not answered yet. It is not in the row: its card under the row asks for it.
 * (Once the user answers, the turn works again and the call is a step like any other, though
 * it counts as waiting until its result is in.)
 */
const isAsking = (step: ToolStep, live: boolean) => step.pending && !live;

/**
 * What a run's row says. Finished: what it did, in the past tense, one clause per kind of call
 * in the order they first came up. A single call says what it was and on what ("Read a file
 * src/main.rs"). While the turn is at work in this run: what it is doing now, in the present
 * tense with an ellipsis. Null when there is nothing to say yet: all the run has is a call that
 * is asking, and its card says that.
 */
/** What a step that is going on right now is doing: "Running a command…", "Thinking…". */
function useDoingLabel() {
  const intl = useIntl();
  return (kind: StepKind | 'thinking', toolName?: string | null) =>
    `${intl.formatMessage(doing[kind], { tool: toolName ?? 'a tool' })}…`;
}

export function useRunLabel() {
  const intl = useIntl();
  const stepLabel = useStepLabel();
  const doingLabel = useDoingLabel();
  return (run: Run, live: boolean): { label: string; detail: string | null } | null => {
    const lastStep = run.steps[run.steps.length - 1];
    if (live && lastStep?.kind === 'tool' && !lastStep.done) {
      return { label: doingLabel(lastStep.tool, lastStep.name), detail: lastStep.target };
    }
    if (live && lastStep?.kind === 'thinking') {
      return { label: doingLabel('thinking'), detail: null };
    }

    const calls = run.steps.filter(
      (step): step is ToolStep => step.kind === 'tool' && !isAsking(step, live)
    );
    if (calls.length === 0) {
      return run.steps.some((step) => step.kind === 'thinking')
        ? { label: intl.formatMessage(i18n.thought), detail: null }
        : null;
    }
    if (calls.length === 1) {
      return { label: stepLabel(calls[0].tool, calls[0].name), detail: calls[0].target };
    }
    const counts = new Map<StepKind, number>();
    for (const { tool } of calls) counts.set(tool, (counts.get(tool) ?? 0) + 1);
    const sentence = Array.from(counts, ([tool, count]) =>
      intl.formatMessage(did[tool], { count })
    ).join(', ');
    return { label: sentence.charAt(0).toUpperCase() + sentence.slice(1), detail: null };
  };
}

function useSecondsSince(startedAt: number, live: boolean): number {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => window.clearInterval(timer);
  }, [live]);
  return Math.max(0, Math.round(now - startedAt));
}

interface TurnRunProps {
  run: Run;
  /** The turn is at work in this run right now (not waiting for the user). */
  live: boolean;
  /** When the turn started (epoch seconds), for the timer on the live row. */
  startedAt: number;
  /** Keep it open (the errors-only view). */
  forceOpen?: boolean;
  /** List only the calls that failed. */
  onlyFailed?: boolean;
  sessionId: string;
  append: (value: string) => void;
  /** Per step of the run: the call's state, and undefined for a step that is not a call. */
  toolStates: readonly (ToolRenderState | undefined)[];
  /** Per step of the run: what the call has reported while running. */
  toolNotifications: readonly (NotificationEvent[] | undefined)[];
}

/**
 * A run of the model's steps as one row, the way Claude's transcript folds them: what the run
 * did and a chevron. Opened, it lists the steps one line each, and each step opens on its own.
 * A call that asks for approval, and any picture the run made, sit under the row in view.
 * A run that is nothing but a call asking for approval has no row yet, only that card.
 */
function TurnRun({
  run,
  live,
  startedAt,
  forceOpen = false,
  onlyFailed = false,
  sessionId,
  append,
  toolStates,
  toolNotifications,
}: TurnRunProps) {
  const intl = useIntl();
  const runLabel = useRunLabel();
  const stepLabel = useStepLabel();
  const doingLabel = useDoingLabel();
  const [clicked, setClicked] = useState(false);
  // The steps are drawn once the row has been opened, and kept after that so a step that was
  // opened (a card, its output) is still open when the row is shut and opened again.
  const [drawn, setDrawn] = useState(false);
  const elapsed = useSecondsSince(startedAt, live);

  const row = runLabel(run, live);
  const open = row !== null && (forceOpen || clicked);
  const lastStep = run.steps[run.steps.length - 1];
  const asking = run.steps.some((step) => step.kind === 'tool' && isAsking(step, live));
  // The calls the turn is waiting on right now: those of the last message that made any, for
  // as long as they have no result.
  const lastCall = run.steps.filter((step): step is ToolStep => step.kind === 'tool').at(-1);
  const isRunning = (step: ToolStep) => live && !step.done && step.index === lastCall?.index;

  const toolCard = (step: ToolStep, at: number) => {
    const state = toolStates[at];
    return (
      <ToolCallWithResponse
        sessionId={sessionId}
        isCancelledMessage={false}
        toolRequest={step.request}
        toolResponse={state?.response}
        notifications={toolNotifications[at]}
        isStreamingMessage={isRunning(step)}
        isPendingApproval={step.pending}
        append={append}
        confirmationContent={state?.confirmation}
        isApprovalClicked={Boolean(state?.confirmation && !step.pending && step.done)}
      />
    );
  };

  return (
    <div className="turn-run min-w-0 max-w-full" data-testid="turn-run">
      {row && (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => {
            setDrawn(true);
            setClicked((value) => !value);
          }}
          className="flex max-w-full min-w-0 items-center gap-1.5 py-1 text-left text-sm text-text-secondary hover:text-text-primary transition-colors cursor-pointer"
        >
          {live && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />}
          <span
            className={cn('min-w-0 truncate', !row.detail && 'shrink-0', live && 'turn-shimmer')}
          >
            {row.label}
          </span>
          {row.detail && (
            <span className="min-w-0 truncate font-mono text-xs opacity-70">{row.detail}</span>
          )}
          {run.failed > 0 && (
            <span className="flex shrink-0 items-center gap-1 text-red-500">
              · <AlertTriangle className="h-3 w-3" />
              {intl.formatMessage(i18n.failed, { count: run.failed })}
            </span>
          )}
          {asking && (
            <span className="shrink-0 text-yellow-600 dark:text-yellow-400">
              · {intl.formatMessage(i18n.waiting)}
            </span>
          )}
          {live && (
            <span className="shrink-0 tabular-nums opacity-70">· {formatDuration(elapsed)}</span>
          )}
          <RowChevron open={open} />
        </button>
      )}

      {row && (open || drawn) && (
        <div
          className={cn(
            'turn-run-steps mt-0.5 mb-1.5 ml-[3px] flex min-w-0 flex-col border-l border-border-subtle pl-3',
            !open && 'hidden'
          )}
        >
          {run.steps.map((step, at) => {
            if (step.kind === 'thinking') {
              if (onlyFailed) return null;
              return (
                <ThinkingStepRow
                  key={step.key}
                  text={step.text}
                  running={live && step === lastStep}
                />
              );
            }
            if (step.kind === 'note') {
              return onlyFailed ? null : <NoteStepRow key={step.key} text={step.text} />;
            }
            if (onlyFailed && !step.failed) return null;
            // Drawn in full under the row, where its buttons are in view.
            if (isAsking(step, live)) return null;
            // A recipe's structured result is a plain line: there is no card behind it.
            if (isFinalOutputToolRequest(step.request)) {
              return (
                <div className="py-[3px]" key={step.key}>
                  <FinalOutputLine
                    toolResponse={toolStates[at]?.response}
                    isStreaming={isRunning(step)}
                  />
                </div>
              );
            }
            return (
              <TurnStepRow
                key={step.key}
                label={
                  isRunning(step)
                    ? doingLabel(step.tool, step.name)
                    : stepLabel(step.tool, step.name)
                }
                detail={step.target}
                failed={step.failed}
                running={isRunning(step)}
              >
                {toolCard(step, at)}
              </TurnStepRow>
            );
          })}
        </div>
      )}

      {!onlyFailed &&
        run.steps.map((step, at) =>
          step.kind === 'tool' && isAsking(step, live) ? (
            <div className="goose-message-tool my-2" key={step.key}>
              {toolCard(step, at)}
            </div>
          ) : null
        )}

      {/* What the run drew stays in view, outside the fold: it is what was asked for. */}
      {!onlyFailed &&
        run.images.map((image, i) => (
          <img
            key={i}
            data-testid="turn-image"
            src={`data:${image.mimeType};base64,${image.data}`}
            alt={image.alt}
            className="my-2 max-h-[32rem] max-w-full rounded-md"
          />
        ))}
    </div>
  );
}

export default memo(TurnRun, isEqual);
