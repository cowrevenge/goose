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
 * Groups one agent turn (everything between two real user messages) into blocks and an
 * always-visible final answer, the way claude.ai shows a turn:
 * - text the model writes between tool calls stays visible, and each piece of it starts a new block;
 * - runs of looking-around calls (reads, searches, listings, fetches, commands) and thinking fold
 *   into one line that says what they did ("Read 4 files, searched 2 patterns");
 * - changes (writes, edits), failures, anything waiting for the user, and sub-agents never fold:
 *   each gets a line of its own;
 * - the model's last text, written after its last tool call, is the answer.
 * A grind loop that runs for hours is one turn, so this is what keeps it readable.
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

/** What a looking-around call did, for a folded group's summary line. */
export type StepKind = 'read' | 'search' | 'list' | 'fetch' | 'command' | 'tool';

export type StepCounts = Partial<Record<StepKind, number>>;

/** Why a step is shown on its own line instead of folding into a group. */
export type StandoutReason = 'attention' | 'failed' | 'write' | 'agent';

export type WorkBlock =
  /** Text the model wrote between steps (with the calls of that same message): always visible. */
  | { kind: 'text'; key: string; entries: DisplayedEntry[] }
  /** A run of looking-around calls and thinking, folded into one summary line. */
  | {
      kind: 'steps';
      key: string;
      entries: DisplayedEntry[];
      counts: StepCounts;
      thinking: boolean;
      /** The latest call in the run, for the live status line. */
      activity: string | null;
    }
  /** A step that must stay in view on its own line. */
  | { kind: 'standout'; key: string; entries: DisplayedEntry[]; reason: StandoutReason };

export type DisplayGroup =
  | { kind: 'single'; entry: DisplayedEntry }
  | {
      kind: 'turn';
      key: string;
      work: DisplayedEntry[];
      /** The work, split into blocks for display. */
      blocks: WorkBlock[];
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
  for (const [kind, keywords] of STEP_KEYWORDS) {
    if (words.some((word) => keywords.includes(word))) return kind;
  }
  return 'tool';
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
      blocks: splitIntoBlocks(work, rowContexts, pendingConfirmationIds),
      final,
      finalThinking,
      stats: { durationS, toolCalls, failedToolCalls, hasThinking, needsAttention, activity },
    },
  ];
}

function hasNarration(message: Message): boolean {
  if (message.role !== 'assistant') return false;
  const { textContent, imagePaths } = getTextAndImageContent(message);
  return textContent.trim().length > 0 || imagePaths.length > 0;
}

/** Why this message's step must stay in view, or null when it can fold into a group. */
function standoutReason(
  { message, index }: DisplayedEntry,
  rowContexts: readonly MessageRowContext[],
  pendingConfirmationIds: ReadonlySet<string>
): StandoutReason | null {
  const confirmation = getAnyToolConfirmationData(message);
  if (confirmation && pendingConfirmationIds.has(confirmation.id)) return 'attention';
  const elicitation = getElicitationContent(message);
  if (elicitation) return 'attention';
  const requests = getToolRequests(message);
  const states = rowContexts[index]?.toolStates ?? [];
  if (states.some((state) => state?.isPending)) return 'attention';
  if (states.some((state) => state?.response && isFailedResult(state.response.toolResult))) {
    return 'failed';
  }
  const kinds = requests.map((request) => classifyToolCall(request.toolCall));
  if (kinds.includes('write')) return 'write';
  if (kinds.includes('agent')) return 'agent';
  return null;
}

/**
 * Splits a turn's work into blocks. Tool-result messages stay with the block of the call they
 * answer. Text written between steps starts a new block, so a long turn reads as what the model
 * said it was doing, with the folded steps under each part.
 */
export function splitIntoBlocks(
  work: readonly DisplayedEntry[],
  rowContexts: readonly MessageRowContext[],
  pendingConfirmationIds: ReadonlySet<string>
): WorkBlock[] {
  const blocks: WorkBlock[] = [];
  const keyOf = (entry: DisplayedEntry) => `block-${entry.message.id ?? entry.index}`;

  for (const entry of work) {
    const { message } = entry;
    const lastBlock = blocks[blocks.length - 1];

    // A tool result belongs with the call it answers, whatever block that is in.
    if (message.role === 'user' && isToolResponseOnly(message)) {
      if (lastBlock) {
        lastBlock.entries.push(entry);
      } else {
        blocks.push({
          kind: 'steps',
          key: keyOf(entry),
          entries: [entry],
          counts: {},
          thinking: false,
          activity: null,
        });
      }
      continue;
    }

    if (hasNarration(message)) {
      blocks.push({ kind: 'text', key: keyOf(entry), entries: [entry] });
      continue;
    }

    const reason = standoutReason(entry, rowContexts, pendingConfirmationIds);
    if (reason) {
      blocks.push({ kind: 'standout', key: keyOf(entry), entries: [entry], reason });
      continue;
    }

    let group = lastBlock?.kind === 'steps' ? lastBlock : null;
    if (!group) {
      group = {
        kind: 'steps',
        key: keyOf(entry),
        entries: [],
        counts: {},
        thinking: false,
        activity: null,
      };
      blocks.push(group);
    }
    group.entries.push(entry);
    if (getThinkingContent(message) !== null) group.thinking = true;
    for (const request of getToolRequests(message)) {
      const kind = classifyToolCall(request.toolCall) as StepKind;
      group.counts[kind] = (group.counts[kind] ?? 0) + 1;
      group.activity = describeToolCall(request.toolCall) ?? group.activity;
    }
  }

  return blocks;
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
