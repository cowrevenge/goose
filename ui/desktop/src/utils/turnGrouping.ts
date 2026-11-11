import {
  getAnyToolConfirmationData,
  getElicitationContent,
  getTextAndImageContent,
  getThinkingContent,
  getToolRequests,
  type Message,
} from '../types/message';
import type { MessageRowContext } from '../components/messageRowContext';

/**
 * Groups one agent turn (everything between two real user messages) into a work part that folds
 * into one line, and an always-visible final answer, the way claude.ai shows a turn. Opened, the
 * work is a flat list of one-line steps (thinking, the model's text, each tool call), each of
 * which opens on its own. Only the model's last text, written after its last tool call, is the
 * answer.
 */

export interface DisplayedEntry {
  message: Message;
  index: number;
}

export interface TurnStats {
  /** Seconds from the turn's first assistant message to its last message. */
  durationS: number;
  /** When the turn's first assistant message was created (epoch seconds), for a live timer. */
  startedAt: number;
  toolCalls: number;
  failedToolCalls: number;
  hasThinking: boolean;
  /** A tool approval or elicitation is waiting inside the work part. */
  needsAttention: boolean;
  /** Short description of what the turn is doing right now (for the live status line). */
  activity: string | null;
}

/** What a tool call did, for its one-line row. */
export type StepKind = 'read' | 'search' | 'list' | 'fetch' | 'command' | 'image' | 'tool';

export type DisplayGroup =
  | { kind: 'single'; entry: DisplayedEntry }
  | {
      kind: 'turn';
      key: string;
      work: DisplayedEntry[];
      final: DisplayedEntry | null;
      /** The final message's thinking, shown at the end of the work part. */
      finalThinking: string | null;
      /** Pictures the turn's tools made (generate_image), shown outside the folded work part. */
      images: MadeImage[];
      stats: TurnStats;
    };

export interface MadeImage {
  data: string;
  mimeType: string;
  /** What was asked for (the prompt), for the alt text. */
  alt: string;
}

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

const ACTIVITY_ARG_KEYS = [
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
  for (const key of ACTIVITY_ARG_KEYS) {
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

export function describeToolCall(toolCall: unknown): string | null {
  const call = unwrapToolCall(toolCall);
  if (!call) return null;
  const tool = shortToolName(call.name);
  for (const key of ACTIVITY_ARG_KEYS) {
    const value = call.arguments[key];
    if (typeof value === 'string' && value.trim()) {
      const oneLine = value.replace(/\s+/g, ' ').trim();
      return `${tool}: ${oneLine.length > 90 ? oneLine.slice(0, 90) + '…' : oneLine}`;
    }
  }
  return tool;
}

const STEP_KEYWORDS: [StepKind | 'write' | 'agent', string[]][] = [
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
export function classifyToolCall(toolCall: unknown): StepKind | 'write' | 'agent' {
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

function buildTurn(
  entries: DisplayedEntry[],
  rowContexts: readonly MessageRowContext[],
  pendingConfirmationIds: ReadonlySet<string>,
  listThinking: boolean
): DisplayGroup[] {
  // With thinking not listed ("Show Thinking: Never"), a turn is built as if it had none.
  const thinkingOf = (message: Message) => (listThinking ? getThinkingContent(message) : null);
  const last = entries[entries.length - 1];
  const final = isAnswerMessage(last.message) ? last : null;
  const work = final ? entries.slice(0, -1) : entries;
  const finalThinking = final ? thinkingOf(final.message) : null;

  // Text between steps only counts as work when there are steps: a run of plain replies with no
  // tool calls and no thinking renders as it always did.
  const workHasActivity = work.some(
    ({ message }) => getToolRequests(message).length > 0 || thinkingOf(message) !== null
  );

  // A plain reply with nothing behind it: render it as it always was.
  if (!workHasActivity && !finalThinking) {
    return entries.map((entry) => ({ kind: 'single', entry }));
  }

  let toolCalls = 0;
  let failedToolCalls = 0;
  let hasThinking = finalThinking !== null;
  let needsAttention = false;
  let activity: string | null = null;
  const images: MadeImage[] = [];

  for (const { message, index } of work) {
    const requests = getToolRequests(message);
    const states = rowContexts[index]?.toolStates ?? [];
    requests.forEach((request, i) => {
      toolCalls++;
      const state = states[i];
      if (state?.response && isFailedResult(state.response.toolResult)) failedToolCalls++;
      if (state?.response && classifyToolCall(request.toolCall) === 'image') {
        const alt = toolCallTarget(request.toolCall) ?? '';
        for (const image of toolResultImages(state.response.toolResult)) {
          images.push({ ...image, alt });
        }
      }
      if (state?.isPending) needsAttention = true;
      activity = describeToolCall(request.toolCall) ?? activity;
    });
    if (thinkingOf(message) !== null) hasThinking = true;

    const confirmation = getAnyToolConfirmationData(message);
    if (confirmation && pendingConfirmationIds.has(confirmation.id)) needsAttention = true;

    const elicitation = getElicitationContent(message);
    const elicitationData = elicitation?.data as
      { isSubmitted?: boolean; isCancelled?: boolean } | undefined;
    if (elicitation && !elicitationData?.isSubmitted && !elicitationData?.isCancelled) {
      needsAttention = true;
    }
  }

  const lastWork = work[work.length - 1];
  if (lastWork && !final) {
    const pendingRequests = getToolRequests(lastWork.message);
    if (pendingRequests.length > 0) {
      activity = describeToolCall(pendingRequests[pendingRequests.length - 1].toolCall) ?? activity;
    } else if (thinkingOf(lastWork.message) !== null) {
      activity = 'Thinking';
    }
  }

  const firstAssistant = entries.find(({ message }) => message.role === 'assistant') ?? entries[0];
  const durationS = Math.max(0, Math.round(last.message.created - firstAssistant.message.created));

  return [
    {
      kind: 'turn',
      key: `turn-${entries[0].message.id ?? entries[0].index}`,
      work,
      final,
      finalThinking,
      images,
      stats: {
        durationS,
        startedAt: firstAssistant.message.created,
        toolCalls,
        failedToolCalls,
        hasThinking,
        needsAttention,
        activity,
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
    pendingConfirmationIds: ReadonlySet<string>;
    /** False when the "Show Thinking" setting is "Never": thinking then makes no steps. Default true. */
    listThinking?: boolean;
    /** Displayed positions where a turn must not continue across (e.g. the "hidden messages" marker). */
    breakBefore?: ReadonlySet<number>;
  }
): DisplayGroup[] {
  const groups: DisplayGroup[] = [];
  let current: DisplayedEntry[] = [];

  const flush = () => {
    if (current.length > 0) {
      groups.push(
        ...buildTurn(
          current,
          options.rowContexts,
          options.pendingConfirmationIds,
          options.listThinking ?? true
        )
      );
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
