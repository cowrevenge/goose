import TurnRun from './TurnRun';
import { TurnNote, TurnThinking } from './TurnStepRow';
import ToolCallConfirmation from './ToolCallConfirmation';
import ElicitationRequest from './ElicitationRequest';
import { SystemNotificationInline } from './context_management/SystemNotificationInline';
import {
  getElicitationContent,
  getToolConfirmationContent,
  type NotificationEvent,
} from '../types/message';
import type { DisplayedEntry, Run, TurnBlock } from '../utils/turnGrouping';
import type { MessageRowContext } from './messageRowContext';

interface TurnProps {
  blocks: readonly TurnBlock[];
  /** When the turn started (epoch seconds), for the timer on the row it is working in. */
  startedAt: number;
  /** The turn is at work: still going, with no answer yet, and not waiting for the user. */
  working: boolean;
  /** Draw only the runs that have a failed call, opened to those calls. */
  errorsOnly: boolean;
  rowContexts: readonly MessageRowContext[];
  toolCallNotifications: Map<string, NotificationEvent[]>;
  sessionId: string;
  append: (value: string) => void;
  /** What to say before a message's blocks, if anything (the model changed). */
  noticeFor: (index: number) => string | null;
  submitElicitationResponse?: (
    elicitationId: string,
    userData: Record<string, unknown>
  ) => Promise<boolean>;
}

/**
 * Everything a turn did before its answer, as Claude's transcript lays it out: the model's text
 * in view, each run of tool calls as one row. See utils/turnGrouping.ts for what goes where.
 */
export default function Turn({
  blocks,
  startedAt,
  working,
  errorsOnly,
  rowContexts,
  toolCallNotifications,
  sessionId,
  append,
  noticeFor,
  submitElicitationResponse,
}: TurnProps) {
  const lastBlock = blocks[blocks.length - 1];
  // The run the turn is in right now is the one at its end; text or a question after it means
  // that run is over.
  const liveRun = working && lastBlock?.kind === 'run' ? lastBlock : null;

  const renderRun = (run: Run) => (
    <TurnRun
      key={run.key}
      run={run}
      live={run === liveRun}
      startedAt={startedAt}
      forceOpen={errorsOnly}
      onlyFailed={errorsOnly}
      sessionId={sessionId}
      append={append}
      toolStates={run.steps.map((step) =>
        step.kind === 'tool' ? rowContexts[step.index]?.toolStates[step.toolIndex] : undefined
      )}
      toolNotifications={run.steps.map((step) =>
        step.kind === 'tool' ? toolCallNotifications.get(step.key) : undefined
      )}
    />
  );

  const renderAttention = (key: string, { message, index }: DisplayedEntry) => {
    const confirmation = getToolConfirmationContent(message);
    const elicitation = getElicitationContent(message);
    const elicitationData =
      elicitation?.data.actionType === 'elicitation'
        ? (elicitation.data as typeof elicitation.data & {
            isSubmitted?: boolean;
            isCancelled?: boolean;
          })
        : undefined;
    return (
      <div key={key} className="turn-attention my-2 self-stretch min-w-0">
        {confirmation !== undefined && !rowContexts[index]?.toolConfirmationShownInline && (
          <ToolCallConfirmation
            sessionId={sessionId}
            isClicked={false}
            actionRequiredContent={confirmation}
          />
        )}
        {elicitation !== undefined && submitElicitationResponse && (
          <ElicitationRequest
            isCancelledMessage={elicitationData?.isCancelled === true}
            isClicked={elicitationData?.isSubmitted === true}
            actionRequiredContent={elicitation}
            onSubmit={submitElicitationResponse}
          />
        )}
      </div>
    );
  };

  return (
    <div className="turn flex w-[90%] min-w-0 flex-col items-start [&>:first-child>.turn-note]:mt-0">
      {blocks.map((block) => {
        if (block.kind === 'run') {
          return errorsOnly && block.failed === 0 ? null : renderRun(block);
        }
        if (errorsOnly) return null;
        switch (block.kind) {
          case 'note':
            return (
              <div key={block.key} className="self-stretch min-w-0">
                <TurnNote text={block.text} />
              </div>
            );
          case 'thinking':
            return (
              <div key={block.key} className="self-stretch min-w-0">
                <TurnThinking text={block.text} />
              </div>
            );
          case 'attention':
            return renderAttention(block.key, block.entry);
          case 'notice': {
            const msg = noticeFor(block.index);
            return msg ? (
              <div key={block.key} className="self-stretch min-w-0">
                <SystemNotificationInline
                  notification={{ msg, notificationType: 'inlineMessage' }}
                />
              </div>
            ) : null;
          }
        }
      })}
    </div>
  );
}
