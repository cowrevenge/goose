import {
  getAnyToolConfirmationData,
  getElicitationContent,
  getTextAndImageContent,
  getThinkingContent,
  getToolConfirmationContent,
  getToolRequests,
  type Message,
  type ToolRequestMessageContent,
} from '../types/message';
import type { MessageRowContext } from '../components/messageRowContext';

/**
 * Lays one agent turn (everything between two real user messages) out the way Claude's own
 * transcript does:
 *
 *  - the model's text stays in view as text;
 *  - every run of tool calls between two pieces of text folds into one row that says what the run
 *    did ("Ran 3 commands, edited a file"), and opens to its calls one line each;
 *  - a short note written on the way to a call ("Now the tests.") folds into that row with the
 *    call, so a model that narrates each step does not break the work into one row per step.
 *    Text before the turn's first call, and anything longer than a sentence or two, stays in view;
 *  - a call that waits for approval is not in a row yet: its card is in view (see TurnRun), and
 *    so is what the model wrote with it, until the call has run;
 *  - thinking follows the "Show Thinking" setting: folded into the rows, in view, or left out;
 *  - only the text after the last call is the answer, drawn in full.
 */

export interface DisplayedEntry {
  message: Message;
  index: number;
}

/** What a tool call did, for its row and for the run's summary. */
export type StepKind =
  'command' | 'read' | 'write' | 'search' | 'list' | 'fetch' | 'image' | 'agent' | 'tool';

/** Where thinking goes: into the rows ("Collapsed"), in view ("Always") or nowhere ("Never"). */
export type ThinkingMode = 'fold' | 'show' | 'hide';

export interface MadeImage {
  data: string;
  mimeType: string;
  /** What was asked for (the prompt), for the alt text. */
  alt: string;
}

export interface ToolStep {
  kind: 'tool';
  /** The tool request's id. */
  key: string;
  /** The message the call is in. */
  index: number;
  /** Which of that message's tool requests this is. */
  toolIndex: number;
  request: ToolRequestMessageContent;
  tool: StepKind;
  /** The tool's own name without its extension prefix. */
  name: string | null;
  /** Its most telling argument (command, path, query...) on one line. */
  target: string | null;
  /** The call has its result. */
  done: boolean;
  failed: boolean;
  /** Waiting for the user's approval. */
  pending: boolean;
}

export type RunStep =
  | ToolStep
  | { kind: 'thinking'; key: string; index: number; text: string }
  | { kind: 'note'; key: string; index: number; text: string };

/** Consecutive steps with no text in view between them: one row in the transcript. */
export interface Run {
  kind: 'run';
  key: string;
  steps: RunStep[];
  failed: number;
  /** A call in here is waiting for the user. */
  pending: boolean;
  /** Pictures its tools made (generate_image), shown under the row. */
  images: MadeImage[];
}

export type TurnBlock =
  | Run
  /** Text the model wrote on the way, in view. */
  | { kind: 'note'; key: string; index: number; text: string }
  /** Thinking in view ("Show Thinking: Always"). */
  | { kind: 'thinking'; key: string; index: number; text: string }
  /** An approval or a question that is not attached to a call in a run. */
  | { kind: 'attention'; key: string; entry: DisplayedEntry }
  /** Something to say before this message's blocks (the model changed). */
  | { kind: 'notice'; key: string; index: number };

export interface TurnStats {
  /** When the turn's first assistant message was created (epoch seconds), for the live timer. */
  startedAt: number;
  failedToolCalls: number;
}

export type DisplayGroup =
  | { kind: 'single'; entry: DisplayedEntry }
  | {
      kind: 'turn';
      key: string;
      blocks: TurnBlock[];
      /** The answer: the text after the last call. Null while the turn is still working. */
      final: DisplayedEntry | null;
      /** The turn's first and last message, as positions in the conversation. */
      firstIndex: number;
      lastIndex: number;
      stats: TurnStats;
    };

/** A user-role message that only carries tool results (or nothing yet): part of the agent's turn. */
export function isToolResponseOnly(message: Message): boolean {
  return message.content.every((content) => content.type === 'toolResponse');
}

function isAnswerMessage(message: Message): boolean {
  if (message.role !== 'assistant') return false;
  if (getToolRequests(message).length > 0) return false;
  if (getAnyToolConfirmationData(message) || getElicitationContent(message)) return false;
  const { textContent, imagePaths } = getTextAndImageContent(message);
  return textContent.trim().length > 0 || imagePaths.length > 0;
}

function unwrapToolCall(
  toolCall: unknown
): { name: string; arguments: Record<string, unknown> } | null {
  const data = toolCall as Record<string, unknown> | undefined;
  if (!data) return null;
  const call = (data.status === 'success' ? data.value : data) as
    { name?: unknown; arguments?: unknown } | undefined;
  if (!call || typeof call.name !== 'string') return null;
  return {
    name: call.name,
    arguments: (call.arguments as Record<string, unknown>) ?? {},
  };
}

function shortToolName(name: string): string {
  const i = name.lastIndexOf('__');
  return i === -1 ? name : name.substring(i + 2);
}

const TARGET_ARG_KEYS = [
  'command',
  'path',
  'file_path',
  'query',
  'pattern',
  'url',
  'name',
  'prompt',
];

/** The call's most telling argument (command, path, query...) on one line, or null. */
export function toolCallTarget(toolCall: unknown): string | null {
  const call = unwrapToolCall(toolCall);
  if (!call) return null;
  for (const key of TARGET_ARG_KEYS) {
    const value = call.arguments[key];
    if (typeof value === 'string' && value.trim()) {
      const oneLine = value.replace(/\s+/g, ' ').trim();
      return oneLine.length > 120 ? oneLine.slice(0, 120) + '…' : oneLine;
    }
  }
  return null;
}

/** The tool's own name without its extension prefix. */
export function toolCallName(toolCall: unknown): string | null {
  const call = unwrapToolCall(toolCall);
  return call ? shortToolName(call.name) : null;
}

const STEP_KEYWORDS: [StepKind, string[]][] = [
  ['agent', ['subagent', 'delegate', 'dynamic', 'task', 'recipe', 'agent']],
  [
    'write',
    [
      'write',
      'edit',
      'create',
      'delete',
      'remove',
      'rename',
      'move',
      'replace',
      'patch',
      'insert',
      'append',
      'save',
      'mkdir',
    ],
  ],
  ['search', ['search', 'grep', 'rg', 'find', 'glob', 'query']],
  ['list', ['list', 'ls', 'tree', 'dir', 'directory']],
  ['fetch', ['fetch', 'browse', 'http', 'url', 'web']],
  ['read', ['read', 'view', 'cat', 'open', 'get', 'show', 'image', 'screenshot']],
  ['command', ['shell', 'bash', 'run', 'exec', 'execute', 'command', 'powershell', 'cmd']],
];

/** What one tool call is, from its name (and the text editor's sub-command). */
export function classifyToolCall(toolCall: unknown): StepKind {
  const call = unwrapToolCall(toolCall);
  if (!call) return 'tool';
  const name = shortToolName(call.name).toLowerCase();
  // One tool, many verbs: the text editor reads with `view` and writes with everything else.
  if (name === 'text_editor' || name === 'str_replace_editor') {
    return call.arguments.command === 'view' ? 'read' : 'write';
  }
  const words = name.split(/[^a-z0-9]+/).filter(Boolean);
  // Making a picture, not reading one: checked first, as "create" alone would read as a write.
  if (
    words.includes('image') &&
    words.some((word) => ['generate', 'create', 'draw', 'render', 'paint'].includes(word))
  ) {
    return 'image';
  }
  for (const [kind, keywords] of STEP_KEYWORDS) {
    if (words.some((word) => keywords.includes(word))) return kind;
  }
  return 'tool';
}

/** The images in a tool's successful result (data + mimeType blocks). */
export function toolResultImages(toolResult: unknown): { data: string; mimeType: string }[] {
  const result = toolResult as Record<string, unknown> | undefined;
  if (!result || result.status !== 'success') return [];
  const content = (result.value as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => {
    const b = block as Record<string, unknown>;
    return typeof b.data === 'string' &&
      typeof b.mimeType === 'string' &&
      b.mimeType.startsWith('image/')
      ? [{ data: b.data, mimeType: b.mimeType }]
      : [];
  });
}

export function isFailedResult(toolResult: unknown): boolean {
  const result = toolResult as Record<string, unknown> | undefined;
  if (!result) return false;
  if (result.status === 'error') return true;
  const value = result.value as Record<string, unknown> | undefined;
  return value?.isError === true;
}

const SHORT_NOTE_MAX_CHARS = 200;

/**
 * A note of a sentence or two, the kind a model writes on its way to a call ("Now the tests.").
 * These fold into the run; anything with more to it (several sentences, a second paragraph, a
 * list, code) is something to read and stays in view.
 */
export function isShortNote(text: string): boolean {
  const note = text.trim();
  if (note.length === 0 || note.length > SHORT_NOTE_MAX_CHARS) return false;
  if (note.includes('```') || /\n\s*\n/.test(note)) return false;
  if (/^\s*(?:[-*+]\s|\d+[.)]\s|#{1,6}\s|>|\|)/m.test(note)) return false;
  const sentences = note.split(/(?<=[.!?。！？])\s+/).filter((part) => part.trim().length > 0);
  return sentences.length <= 2;
}

// What stands in for a reply that ran out of output tokens is a notice, not something the model
// wrote: it is neither a note nor thinking.
function isOutputLimitFallback(message: Message): boolean {
  return (
    message.metadata.outputTokenLimitReached === true && message.metadata.fallbackContent === true
  );
}

interface TurnOptions {
  rowContexts: readonly MessageRowContext[];
  thinking: ThinkingMode;
  noticeBefore: ReadonlySet<number>;
}

function buildTurn(entries: DisplayedEntry[], options: TurnOptions): DisplayGroup[] {
  const { rowContexts, thinking: thinkingMode, noticeBefore } = options;
  const last = entries[entries.length - 1];
  const final = isAnswerMessage(last.message) ? last : null;
  const work = final ? entries.slice(0, -1) : entries;

  // A short note folds only when a call follows it somewhere in the turn.
  let lastCallIndex = -1;
  for (const { message, index } of work) {
    if (getToolRequests(message).length > 0) lastCallIndex = index;
  }

  const blocks: TurnBlock[] = [];
  let run: Run | null = null;
  // Text before the turn's first call is the model answering the user: always in view.
  let seenCall = false;

  // A run is known by its first step, which stays the same while steps are added behind it.
  const openRun = (firstStepKey: string): Run => {
    if (!run) {
      run = {
        kind: 'run',
        key: `run-${firstStepKey}`,
        steps: [],
        failed: 0,
        pending: false,
        images: [],
      };
    }
    return run;
  };
  const closeRun = () => {
    if (!run) return;
    // Notes fold in with the calls they lead to. A run that got no call after all (what came
    // next was text long enough to stay in view) leaves its notes where they were: in view.
    if (run.steps.every((step) => step.kind === 'note')) {
      for (const step of run.steps) {
        blocks.push({ kind: 'note', key: step.key, index: step.index, text: step.text });
      }
    } else {
      blocks.push(run);
    }
    run = null;
  };
  const addThinking = (key: string, index: number, text: string) => {
    if (thinkingMode === 'fold') {
      const stepKey = `thinking-${key}`;
      openRun(stepKey).steps.push({ kind: 'thinking', key: stepKey, index, text });
    } else if (thinkingMode === 'show') {
      closeRun();
      blocks.push({ kind: 'thinking', key: `thinking-${key}`, index, text });
    }
  };

  for (const entry of work) {
    const { message, index } = entry;
    // The tool-result messages of the turn: their results are on the calls already.
    if (message.role !== 'assistant') continue;
    const key = message.id ?? `msg-${index}`;
    const fallback = isOutputLimitFallback(message);

    if (noticeBefore.has(index)) {
      closeRun();
      blocks.push({ kind: 'notice', key: `notice-${key}`, index });
    }

    const thinking = fallback ? null : getThinkingContent(message);
    if (thinking !== null) addThinking(key, index, thinking);

    const requests = getToolRequests(message);
    const states = rowContexts[index]?.toolStates ?? [];
    const text = fallback ? '' : getTextAndImageContent(message).textContent;
    if (text.trim()) {
      const callFollows = requests.length > 0 || index < lastCallIndex;
      // What the model wrote with a call that waits for approval is what the user reads to
      // decide: it stays in view until the call has run.
      const waiting = states.some((state) => state.isPending);
      if (seenCall && callFollows && !waiting && isShortNote(text)) {
        const stepKey = `note-${key}`;
        openRun(stepKey).steps.push({ kind: 'note', key: stepKey, index, text });
      } else {
        closeRun();
        blocks.push({ kind: 'note', key: `note-${key}`, index, text });
      }
    }

    requests.forEach((request, toolIndex) => {
      seenCall = true;
      const state = states[toolIndex];
      const tool = classifyToolCall(request.toolCall);
      const target = toolCallTarget(request.toolCall);
      const failed = Boolean(state?.response && isFailedResult(state.response.toolResult));
      const pending = state?.isPending === true;
      const current = openRun(request.id);
      current.steps.push({
        kind: 'tool',
        key: request.id,
        index,
        toolIndex,
        request,
        tool,
        name: toolCallName(request.toolCall),
        target,
        done: state?.response !== undefined,
        failed,
        pending,
      });
      if (failed) current.failed++;
      if (pending) current.pending = true;
      if (tool === 'image' && state?.response) {
        for (const image of toolResultImages(state.response.toolResult)) {
          current.images.push({ ...image, alt: target ?? '' });
        }
      }
    });

    // An approval or a question that stands on its own (not drawn on a call's card).
    const standaloneConfirmation =
      getToolConfirmationContent(message) !== undefined &&
      !rowContexts[index]?.toolConfirmationShownInline;
    if (standaloneConfirmation || getElicitationContent(message)) {
      closeRun();
      blocks.push({ kind: 'attention', key: `attention-${key}`, entry });
    }
  }

  // The answer's own thinking comes after the last call, so it ends the last run.
  if (final && !isOutputLimitFallback(final.message)) {
    const thinking = getThinkingContent(final.message);
    if (thinking !== null) {
      addThinking(final.message.id ?? `msg-${final.index}`, final.index, thinking);
    }
  }
  closeRun();

  // Nothing but text: plain replies, drawn as they always were.
  if (blocks.every((block) => block.kind === 'note')) {
    return entries.map((entry) => ({ kind: 'single', entry }));
  }

  const runs = blocks.filter((block): block is Run => block.kind === 'run');
  const firstAssistant = entries.find(({ message }) => message.role === 'assistant') ?? entries[0];

  return [
    {
      kind: 'turn',
      key: `turn-${entries[0].message.id ?? entries[0].index}`,
      blocks,
      final,
      firstIndex: entries[0].index,
      lastIndex: last.index,
      stats: {
        startedAt: firstAssistant.message.created,
        failedToolCalls: runs.reduce((sum, item) => sum + item.failed, 0),
      },
    },
  ];
}

export function groupIntoTurns(
  displayed: readonly DisplayedEntry[],
  options: {
    isUserMessage: (message: Message) => boolean;
    isNotification: (message: Message) => boolean;
    rowContexts: readonly MessageRowContext[];
    /** Where thinking goes. Default: folded into the rows. */
    thinking?: ThinkingMode;
    /** Messages that get a notice block before their own (a model change). */
    noticeBefore?: ReadonlySet<number>;
    /** Displayed positions where a turn must not continue across (e.g. the "hidden messages" marker). */
    breakBefore?: ReadonlySet<number>;
  }
): DisplayGroup[] {
  const groups: DisplayGroup[] = [];
  let current: DisplayedEntry[] = [];
  const turnOptions: TurnOptions = {
    rowContexts: options.rowContexts,
    thinking: options.thinking ?? 'fold',
    noticeBefore: options.noticeBefore ?? new Set(),
  };

  const flush = () => {
    if (current.length > 0) {
      groups.push(...buildTurn(current, turnOptions));
      current = [];
    }
  };

  displayed.forEach((entry, position) => {
    if (options.breakBefore?.has(position)) flush();
    const { message } = entry;
    if (options.isNotification(message)) {
      flush();
      groups.push({ kind: 'single', entry });
    } else if (options.isUserMessage(message) && !isToolResponseOnly(message)) {
      flush();
      groups.push({ kind: 'single', entry });
    } else {
      current.push(entry);
    }
  });
  flush();

  return groups;
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return s ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
