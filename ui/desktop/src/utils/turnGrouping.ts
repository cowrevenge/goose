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
 * Groups one agent turn (everything between two real user messages) into a
 * collapsible "work" part and an always-visible final answer, the way claude.ai
 * shows a turn: thinking, tool calls, tool results and the text written between
 * tool calls go in the work part; only the model's last text, written after its
 * last tool call, is the answer.
 */

export interface DisplayedEntry {
  message: Message;
  index: number;
}

export interface TurnStats {
  /** Seconds from the turn's first assistant message to its last message. */
  durationS: number;
  toolCalls: number;
  failedToolCalls: number;
  hasThinking: boolean;
  /** A tool approval or elicitation is waiting inside the work part. */
  needsAttention: boolean;
  /** Short description of what the turn is doing right now (for the live status line). */
  activity: string | null;
}

export type DisplayGroup =
  | { kind: 'single'; entry: DisplayedEntry }
  | {
      kind: 'turn';
      key: string;
      work: DisplayedEntry[];
      final: DisplayedEntry | null;
      /** The final message's thinking, shown at the end of the work part. */
      finalThinking: string | null;
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

const ACTIVITY_ARG_KEYS = ['command', 'path', 'file_path', 'query', 'pattern', 'url', 'name'];

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

function isFailedResult(toolResult: unknown): boolean {
  const result = toolResult as Record<string, unknown> | undefined;
  if (!result) return false;
  if (result.status === 'error') return true;
  const value = result.value as Record<string, unknown> | undefined;
  return value?.isError === true;
}

function buildTurn(
  entries: DisplayedEntry[],
  rowContexts: readonly MessageRowContext[],
  pendingConfirmationIds: ReadonlySet<string>
): DisplayGroup[] {
  const last = entries[entries.length - 1];
  const final = isAnswerMessage(last.message) ? last : null;
  const work = final ? entries.slice(0, -1) : entries;
  const finalThinking = final ? getThinkingContent(final.message) : null;

  // Text between steps only counts as work when there are steps: a run of plain replies with no
  // tool calls and no thinking renders as it always did.
  const workHasActivity = work.some(
    ({ message }) => getToolRequests(message).length > 0 || getThinkingContent(message) !== null
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

  for (const { message, index } of work) {
    const requests = getToolRequests(message);
    const states = rowContexts[index]?.toolStates ?? [];
    requests.forEach((request, i) => {
      toolCalls++;
      const state = states[i];
      if (state?.response && isFailedResult(state.response.toolResult)) failedToolCalls++;
      if (state?.isPending) needsAttention = true;
      activity = describeToolCall(request.toolCall) ?? activity;
    });
    if (getThinkingContent(message) !== null) hasThinking = true;

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
    } else if (getThinkingContent(lastWork.message) !== null) {
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
      stats: { durationS, toolCalls, failedToolCalls, hasThinking, needsAttention, activity },
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
    /** Displayed positions where a turn must not continue across (e.g. the "hidden messages" marker). */
    breakBefore?: ReadonlySet<number>;
  }
): DisplayGroup[] {
  const groups: DisplayGroup[] = [];
  let current: DisplayedEntry[] = [];

  const flush = () => {
    if (current.length > 0) {
      groups.push(...buildTurn(current, options.rowContexts, options.pendingConfirmationIds));
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
