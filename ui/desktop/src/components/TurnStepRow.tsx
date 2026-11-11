import { memo, useState, type ReactNode } from 'react';
import { AlertTriangle, ChevronRight, Loader2 } from 'lucide-react';
import MarkdownContent from './MarkdownContent';
import { cn } from '../utils';
import { getTextDirection } from '../utils/textDirection';
import { defineMessages, useIntl } from '../i18n';
import type { StepKind } from '../utils/turnGrouping';

const i18n = defineMessages({
  command: { id: 'turnStep.command', defaultMessage: 'Ran a command' },
  read: { id: 'turnStep.read', defaultMessage: 'Read a file' },
  write: { id: 'turnStep.write', defaultMessage: 'Edited a file' },
  search: { id: 'turnStep.search', defaultMessage: 'Searched' },
  list: { id: 'turnStep.list', defaultMessage: 'Listed a folder' },
  fetch: { id: 'turnStep.fetch', defaultMessage: 'Fetched a page' },
  image: { id: 'turnStep.image', defaultMessage: 'Generated an image' },
  agent: { id: 'turnStep.agent', defaultMessage: 'Ran a sub-agent' },
  tool: { id: 'turnStep.tool', defaultMessage: 'Used {tool}' },
  thinking: { id: 'turnStep.thinking', defaultMessage: 'Thinking' },
});

/** What one step did, as its row says it: "Ran a command", "Read a file", "Used remember". */
export function useStepLabel() {
  const intl = useIntl();
  return (kind: StepKind | 'thinking', toolName?: string | null) =>
    kind === 'tool'
      ? intl.formatMessage(i18n.tool, { tool: toolName ?? 'a tool' })
      : intl.formatMessage(i18n[kind]);
}

/** The chevron every row that opens ends in: it points right, and down once the row is open. */
export function RowChevron({ open }: { open: boolean }) {
  return (
    <ChevronRight
      className={cn(
        'h-3.5 w-3.5 shrink-0 opacity-60 transition-transform duration-150',
        open && 'rotate-90'
      )}
    />
  );
}

interface TurnStepRowProps {
  label: string;
  /** Faint text after the label: the command, the file. */
  detail?: string | null;
  failed?: boolean;
  running?: boolean;
  /** What opens under the row when it is clicked. */
  children: ReactNode;
}

/** One step of a run on one line. Click it to see that step in full. */
export function TurnStepRow({ label, detail, failed, running, children }: TurnStepRowProps) {
  const [open, setOpen] = useState(false);
  return (
    <div className="turn-step min-w-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex max-w-full min-w-0 items-center gap-1.5 py-[3px] text-left text-[13px] leading-5 text-text-secondary hover:text-text-primary transition-colors cursor-pointer"
      >
        {running && <Loader2 className="h-3 w-3 shrink-0 animate-spin" />}
        <span className={cn('shrink-0', failed && 'text-red-500')}>{label}</span>
        {detail && <span className="truncate font-mono text-xs opacity-70">{detail}</span>}
        {failed && <AlertTriangle className="h-3 w-3 shrink-0 text-red-500" />}
        <RowChevron open={open} />
      </button>
      {open && <div className="mt-1 mb-2 min-w-0">{children}</div>}
    </div>
  );
}

/** A thinking block as a step of a run: closed until it is clicked. */
export function ThinkingStepRow({ text, running }: { text: string; running?: boolean }) {
  const stepLabel = useStepLabel();
  return (
    <TurnStepRow label={stepLabel('thinking')} running={running}>
      <TurnThinkingText text={text} />
    </TurnStepRow>
  );
}

/** The model's thinking, in the quiet colour it has everywhere. */
export function TurnThinkingText({ text }: { text: string }) {
  return <MarkdownContent content={text} className="!text-text-secondary [&_*]:!text-inherit" />;
}

/** A short note the model wrote on its way to a call, in line with the steps around it. */
export function NoteStepRow({ text }: { text: string }) {
  return (
    <div className="turn-step-note min-w-0 py-[3px] text-[13px] leading-5">
      <MarkdownContent content={text} className="!text-[13px] [&_p]:!mb-0" />
    </div>
  );
}

/**
 * Text the model wrote between runs, in view. It is drawn as a reply's text is (GooseMessage's
 * own element and class), so text stays exactly where it is when the reply it streamed in as
 * goes on to make a call and becomes a note.
 */
export const TurnNote = memo(function TurnNote({ text }: { text: string }) {
  return (
    <div
      className="turn-note agent-message-bubble my-2 w-full min-w-0"
      dir={getTextDirection(text) ?? undefined}
    >
      <MarkdownContent content={text} className="[&>*:last-child]:!mb-0" />
    </div>
  );
});

/** Thinking in view ("Show Thinking: Always"): the text itself, quiet, between the rows. */
export const TurnThinking = memo(function TurnThinking({ text }: { text: string }) {
  return (
    <div className="turn-thinking my-2 min-w-0 border-l border-border-subtle pl-3">
      <TurnThinkingText text={text} />
    </div>
  );
});
