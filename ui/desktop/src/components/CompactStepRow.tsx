import { useState, type ReactNode } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import Expand from './ui/Expand';
import MarkdownContent from './MarkdownContent';
import { cn } from '../utils';
import { defineMessages, useIntl } from '../i18n';
import { StepsStartCollapsedContext, useTurnWorkOpen } from './turnWorkContext';
import { useShowThinking } from '../hooks/useShowThinking';
import type { StepKind } from '../utils/turnGrouping';

const i18n = defineMessages({
  read: { id: 'compactStep.read', defaultMessage: 'Read a file' },
  search: { id: 'compactStep.search', defaultMessage: 'Searched' },
  list: { id: 'compactStep.list', defaultMessage: 'Listed a folder' },
  fetch: { id: 'compactStep.fetch', defaultMessage: 'Fetched a page' },
  command: { id: 'compactStep.command', defaultMessage: 'Ran a command' },
  image: { id: 'compactStep.image', defaultMessage: 'Generated an image' },
  write: { id: 'compactStep.write', defaultMessage: 'Edited a file' },
  agent: { id: 'compactStep.agent', defaultMessage: 'Ran a sub-agent' },
  tool: { id: 'compactStep.tool', defaultMessage: 'Used {tool}' },
  thinking: { id: 'compactStep.thinking', defaultMessage: 'Thinking' },
});

/** The one-line label of a step: what kind of thing it did. */
export function useStepLabel() {
  const intl = useIntl();
  return (kind: StepKind | 'write' | 'agent' | 'thinking', toolName?: string | null) =>
    kind === 'tool'
      ? intl.formatMessage(i18n.tool, { tool: toolName ?? 'a tool' })
      : intl.formatMessage(i18n[kind]);
}

interface CompactStepRowProps {
  label: string;
  /** Faint text after the label, e.g. the command or the file. */
  detail?: string | null;
  failed?: boolean;
  running?: boolean;
  /** Open until it is clicked shut (thinking, when the setting says to always show it). */
  startOpen?: boolean;
  /** What opens under the row when it is clicked. */
  children: ReactNode;
}

/** One step of a turn on one line: click it to see that step in full. */
export function CompactStepRow({
  label,
  detail,
  failed,
  running,
  startOpen = false,
  children,
}: CompactStepRowProps) {
  const [clicked, setClicked] = useState<boolean | null>(null);
  const sectionOpen = useTurnWorkOpen();
  const open = clicked ?? (startOpen && sectionOpen);
  return (
    <div className="compact-step min-w-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setClicked(!open)}
        className="flex w-full min-w-0 items-center gap-1.5 py-0.5 text-left text-xs text-text-secondary hover:text-text-primary transition-colors cursor-pointer"
      >
        {running ? (
          <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
        ) : (
          <Expand size={3} isExpanded={open} />
        )}
        <span className={cn('shrink-0', failed && 'text-red-500')}>{label}</span>
        {detail && <span className="truncate font-mono opacity-70">{detail}</span>}
        {failed && <AlertTriangle className="h-3 w-3 shrink-0 text-red-500" />}
      </button>
      {open && (
        <div className="mt-1 mb-2 ml-[5px] border-l border-border-subtle pl-4">
          {/* Opened on purpose, so show the step in full rather than as another folded line. */}
          <StepsStartCollapsedContext.Provider value={false}>
            {children}
          </StepsStartCollapsedContext.Provider>
        </div>
      )}
    </div>
  );
}

/**
 * A thinking block as a step. The "Show Thinking" setting decides how: listed closed
 * ("Collapsed"), listed already open ("Always"), or not listed at all ("Never").
 */
export function ThinkingStepRow({ content, running }: { content: string; running?: boolean }) {
  const showThinking = useShowThinking();
  const stepLabel = useStepLabel();
  // Wait for the setting, so "Never" and "Always" do not flash a closed row first.
  if (showThinking === null || showThinking === 'never') return null;
  return (
    <CompactStepRow
      label={stepLabel('thinking')}
      running={running}
      startOpen={showThinking === 'always'}
    >
      <div className="text-sm text-text-secondary">
        <MarkdownContent content={content} />
      </div>
    </CompactStepRow>
  );
}

/** Text the model wrote between steps: up to two lines, click to read all of it. */
export function CompactTextRow({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  if (open) {
    return (
      <div className="compact-text cursor-pointer py-0.5 text-sm" onClick={() => setOpen(false)}>
        <MarkdownContent content={text} />
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={() => setOpen(true)}
      className="compact-text block w-full py-0.5 text-left text-sm text-text-primary line-clamp-2 cursor-pointer"
    >
      {text}
    </button>
  );
}
