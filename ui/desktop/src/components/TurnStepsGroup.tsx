import { useState, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './ui/collapsible';
import Expand from './ui/Expand';
import { defineMessages, useIntl } from '../i18n';
import type { StepCounts, StepKind } from '../utils/turnGrouping';
import { StepsStartCollapsedContext } from './turnWorkContext';

const i18n = defineMessages({
  read: {
    id: 'turnSteps.read',
    defaultMessage: '{count, plural, one {read # file} other {read # files}}',
  },
  search: {
    id: 'turnSteps.search',
    defaultMessage: '{count, plural, one {searched # time} other {searched # times}}',
  },
  list: {
    id: 'turnSteps.list',
    defaultMessage: '{count, plural, one {listed # folder} other {listed # folders}}',
  },
  fetch: {
    id: 'turnSteps.fetch',
    defaultMessage: '{count, plural, one {fetched # page} other {fetched # pages}}',
  },
  command: {
    id: 'turnSteps.command',
    defaultMessage: '{count, plural, one {ran # command} other {ran # commands}}',
  },
  tool: {
    id: 'turnSteps.tool',
    defaultMessage: '{count, plural, one {used # tool} other {used # tools}}',
  },
  thought: { id: 'turnSteps.thought', defaultMessage: 'thought' },
  working: { id: 'turnSteps.working', defaultMessage: 'Working' },
});

const ORDER: StepKind[] = ['read', 'search', 'list', 'fetch', 'command', 'tool'];

interface TurnStepsGroupProps {
  counts: StepCounts;
  thinking: boolean;
  /** The group is the turn's current step: show what it is doing right now. */
  live: boolean;
  activity: string | null;
  children: ReactNode;
}

/**
 * A run of looking-around steps (reads, searches, commands, thinking), folded into one line that
 * says what they did. Opening it shows one line per step; each step opens on its own.
 */
export default function TurnStepsGroup({
  counts,
  thinking,
  live,
  activity,
  children,
}: TurnStepsGroupProps) {
  const intl = useIntl();
  const [open, setOpen] = useState(false);

  const parts = ORDER.filter((kind) => (counts[kind] ?? 0) > 0).map((kind) =>
    intl.formatMessage(i18n[kind], { count: counts[kind] })
  );
  if (parts.length === 0 && thinking) parts.push(intl.formatMessage(i18n.thought));
  let summary = parts.join(', ');
  summary = summary.charAt(0).toUpperCase() + summary.slice(1);
  if (live) summary = activity ?? (summary || intl.formatMessage(i18n.working));

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="turn-steps my-2 w-[90%] min-w-0">
      <CollapsibleTrigger className="flex max-w-full items-center gap-1.5 text-xs text-text-secondary hover:text-text-primary transition-colors cursor-pointer min-w-0">
        {live ? (
          <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
        ) : (
          <Expand size={3} isExpanded={open} />
        )}
        <span className="truncate">{summary}</span>
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
