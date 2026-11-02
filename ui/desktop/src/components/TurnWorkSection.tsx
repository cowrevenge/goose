import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './ui/collapsible';
import Expand from './ui/Expand';
import { defineMessages, useIntl } from '../i18n';
import { formatDuration, type TurnStats } from '../utils/turnGrouping';
import { StepsStartCollapsedContext } from './turnWorkContext';

const i18n = defineMessages({
  working: { id: 'turnWork.working', defaultMessage: 'Working' },
  worked: { id: 'turnWork.worked', defaultMessage: 'Worked for {duration}' },
  thought: { id: 'turnWork.thought', defaultMessage: 'Thought for {duration}' },
  toolCalls: {
    id: 'turnWork.toolCalls',
    defaultMessage: '{count, plural, one {# tool call} other {# tool calls}}',
  },
  failed: { id: 'turnWork.failed', defaultMessage: '{count} failed' },
  needsAttention: { id: 'turnWork.needsAttention', defaultMessage: 'Waiting for you' },
  noAnswer: { id: 'turnWork.noAnswer', defaultMessage: 'Ended without a final answer' },
});

interface TurnWorkSectionProps {
  stats: TurnStats;
  isStreaming: boolean;
  hasFinal: boolean;
  children: ReactNode;
}

/**
 * Everything the model did before its answer, in one block. While the turn runs it is a single
 * live status line; when it ends it collapses to a one-line summary. It opens by itself when a
 * tool approval or question is waiting, or when the turn ended without an answer.
 */
export default function TurnWorkSection({
  stats,
  isStreaming,
  hasFinal,
  children,
}: TurnWorkSectionProps) {
  const intl = useIntl();
  const autoOpen = stats.needsAttention || (!isStreaming && !hasFinal);
  const [manualOpen, setManualOpen] = useState<boolean | null>(null);
  const prevAutoOpen = useRef(autoOpen);

  // When the reason to auto-open goes away (approval given), drop back to the default.
  useEffect(() => {
    if (prevAutoOpen.current && !autoOpen) setManualOpen(null);
    prevAutoOpen.current = autoOpen;
  }, [autoOpen]);

  const open = manualOpen ?? autoOpen;

  const parts: string[] = [];
  if (isStreaming) {
    parts.push(stats.activity ?? intl.formatMessage(i18n.working));
  } else {
    const duration = formatDuration(stats.durationS);
    parts.push(
      stats.toolCalls > 0
        ? intl.formatMessage(i18n.worked, { duration })
        : intl.formatMessage(i18n.thought, { duration })
    );
    if (stats.toolCalls > 0)
      parts.push(intl.formatMessage(i18n.toolCalls, { count: stats.toolCalls }));
    if (!hasFinal) parts.push(intl.formatMessage(i18n.noAnswer));
  }

  return (
    <Collapsible
      open={open}
      onOpenChange={(next) => setManualOpen(next)}
      className="turn-work mb-3 w-[90%] min-w-0"
    >
      <CollapsibleTrigger className="flex max-w-full items-center gap-1.5 text-xs text-text-secondary hover:text-text-primary transition-colors cursor-pointer min-w-0">
        {isStreaming ? (
          <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
        ) : (
          <Expand size={3} isExpanded={open} />
        )}
        <span className="truncate">{parts.join(' · ')}</span>
        {stats.failedToolCalls > 0 && (
          <span className="flex shrink-0 items-center gap-1 text-red-500">
            · <AlertTriangle className="h-3 w-3" />
            {intl.formatMessage(i18n.failed, { count: stats.failedToolCalls })}
          </span>
        )}
        {stats.needsAttention && (
          <span className="shrink-0 text-yellow-600 dark:text-yellow-400">
            · {intl.formatMessage(i18n.needsAttention)}
          </span>
        )}
      </CollapsibleTrigger>
      {/* Stay mounted while closed so tool cards keep their state (timers, expanded output). */}
      <CollapsibleContent forceMount className="data-[state=closed]:hidden">
        <div className="mt-2 ml-[5px] border-l border-border-subtle pl-4">
          <StepsStartCollapsedContext.Provider value={true}>
            {children}
          </StepsStartCollapsedContext.Provider>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
