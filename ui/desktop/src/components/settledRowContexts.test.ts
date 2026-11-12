import type { GooseSessionNotification_unstable } from '@aaif/goose-acp-client';
import type { SessionNotification } from '@agentclientprotocol/sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { acpChatSessionActions } from '../acp/chatSessionStore';
import type { AcpPermissionRequest } from '../acp/permissionRequestTypes';
import type { Message } from '../types/message';
import type { Session } from '../types/session';
import { deriveMessageRowContexts } from './messageRowContext';
import { settleRowContexts, type SettledRowContexts } from './settledRowContexts';

// The contexts kept while a reply streams in must be the ones that working them out again
// would give. The conversations here are the store's own, so messages are shared and replaced
// between snapshots the way they are in the app.

const update = (sessionId: string, value: object): SessionNotification =>
  ({ sessionId, update: value }) as unknown as SessionNotification;
const gooseUpdate = (sessionId: string, value: object): GooseSessionNotification_unstable =>
  ({ sessionId, update: value }) as unknown as GooseSessionNotification_unstable;

interface Inference {
  provider: string;
  requestedModel: string;
  resolvedModel?: string;
}

const chunk = (
  kind: 'agent_message_chunk' | 'agent_thought_chunk' | 'user_message_chunk',
  sessionId: string,
  messageId: string,
  text: string,
  inference?: Inference
) =>
  update(sessionId, {
    sessionUpdate: kind,
    messageId,
    content: { type: 'text', text },
    ...(inference ? { _meta: { goose: { messageId, inference } } } : {}),
  });

const toolCall = (sessionId: string, messageId: string, toolCallId: string) =>
  update(sessionId, {
    sessionUpdate: 'tool_call',
    toolCallId,
    title: 'Shell command',
    status: 'pending',
    rawInput: { command: 'cargo build' },
    _meta: { goose: { messageId, toolCall: { toolName: 'developer__shell' } } },
  });

const toolResult = (sessionId: string, messageId: string, toolCallId: string, failed: boolean) =>
  update(sessionId, {
    sessionUpdate: 'tool_call_update',
    toolCallId,
    status: failed ? 'failed' : 'completed',
    content: [{ type: 'content', content: { type: 'text', text: failed ? 'error' : 'ok' } }],
    _meta: { goose: { messageId } },
  });

const permissionRequest = (sessionId: string, toolCallId: string): AcpPermissionRequest => ({
  generation: `generation-${toolCallId}`,
  request: {
    sessionId,
    options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }],
    toolCall: { toolCallId, title: 'Shell command', rawInput: { command: 'cargo build' } },
  },
});

describe('settleRowContexts', () => {
  const sessionIds = new Set<string>();
  const start = (id: string): string => {
    sessionIds.add(id);
    acpChatSessionActions.finishSessionLoad(id, { id, name: id } as Session);
    acpChatSessionActions.startPromptAttempt(id, 'attempt-1');
    return id;
  };
  const apply = (notification: SessionNotification) =>
    acpChatSessionActions.applyAcpSessionNotification(notification).messages;

  afterEach(() => {
    for (const id of sessionIds) {
      acpChatSessionActions.deleteSnapshot(id);
    }
    sessionIds.clear();
  });

  it('keeps what it worked out while a reply streams in', () => {
    const id = start('settled-1');
    apply(chunk('user_message_chunk', id, 'u1', 'Is the build green?'));
    apply(chunk('agent_message_chunk', id, 'a1', 'Let me check.'));
    apply(toolCall(id, 'a1', 't1'));
    apply(toolResult(id, 'r1', 't1', false));
    const first = settleRowContexts(undefined, apply(chunk('agent_thought_chunk', id, 'a2', 'It')));
    expect(first.contexts).toHaveLength(4);

    // More thinking, then text that was already there growing: nothing a context is made of.
    const thinking = settleRowContexts(
      first,
      apply(chunk('agent_thought_chunk', id, 'a2', ' compiled.'))
    );
    const text = apply(chunk('agent_message_chunk', id, 'a2', 'Yes'));
    const withText = settleRowContexts(thinking, text);
    const moreText = settleRowContexts(
      withText,
      apply(chunk('agent_message_chunk', id, 'a2', ', it is green.'))
    );

    expect(thinking).toBe(first);
    // The first text is a change: a message with text ends a chain of tool calls.
    expect(withText).not.toBe(thinking);
    expect(withText.messages).toBe(text);
    expect(moreText).toBe(withText);
    expect(moreText.contexts).toEqual(deriveMessageRowContexts(moreText.messages));
  });

  it('works them out again for a call, a result, an approval and a change of model', () => {
    const id = start('settled-2');
    apply(chunk('user_message_chunk', id, 'u1', 'Is the build green?'));
    const model = { provider: 'local', requestedModel: 'qwen', resolvedModel: 'qwen-a' };
    let settled = settleRowContexts(
      undefined,
      apply(chunk('agent_message_chunk', id, 'a1', 'Let me check.', model))
    );

    const changes: Message[][] = [
      apply(toolCall(id, 'a1', 't1')),
      acpChatSessionActions.applyPermissionRequest(permissionRequest(id, 't1')).messages,
      apply(toolResult(id, 'r1', 't1', true)),
      apply(
        chunk('agent_message_chunk', id, 'a2', 'It failed.', { ...model, resolvedModel: 'qwen-b' })
      ),
    ];

    for (const messages of changes) {
      const next = settleRowContexts(settled, messages);
      expect(next).not.toBe(settled);
      expect(next.messages).toBe(messages);
      expect(next.contexts).toEqual(deriveMessageRowContexts(messages));
      settled = next;
    }
    expect(settled.contexts[1].toolStates[0]).toMatchObject({ requestId: 't1', isPending: false });
    expect(settled.contexts[4].previousModel).toMatchObject({ id: 'qwen-a' });
  });

  it('tells apart every difference a context depends on, in any message', () => {
    const meta = (inference?: Inference): Message['metadata'] => ({
      userVisible: true,
      agentVisible: true,
      ...(inference ? { inference } : {}),
    });
    const request = (toolCallId: string): Message['content'][number] => ({
      type: 'toolRequest',
      id: toolCallId,
      toolCall: { status: 'success', value: { name: 'developer__shell', arguments: {} } },
    });
    const response = (toolCallId: string, isError = false): Message['content'][number] => ({
      type: 'toolResponse',
      id: toolCallId,
      toolResult: { status: 'success', value: { content: [], isError } },
    });
    const qwen = (resolvedModel: string): Inference => ({
      provider: 'local',
      requestedModel: 'qwen',
      resolvedModel,
    });
    const base: Message[] = [
      { role: 'user', created: 1, content: [{ type: 'text', text: 'go' }], metadata: meta() },
      {
        role: 'assistant',
        created: 2,
        content: [{ type: 'text', text: 'Checking.' }, request('t1')],
        metadata: meta(qwen('qwen-a')),
      },
      { role: 'user', created: 3, content: [response('t1')], metadata: meta() },
      { role: 'assistant', created: 4, content: [request('t2')], metadata: meta(qwen('qwen-b')) },
      { role: 'user', created: 5, content: [response('t2')], metadata: meta() },
      {
        role: 'assistant',
        created: 6,
        content: [{ type: 'text', text: 'Done.' }],
        metadata: meta(qwen('qwen-b')),
      },
    ];
    const settled = settleRowContexts(undefined, base);
    // The replies as new objects, the way a streamed chunk leaves them.
    const copy = (change: (messages: Message[]) => void = () => {}): Message[] => {
      const messages = base.map((message) =>
        message.role === 'assistant'
          ? { ...message, content: [...message.content], metadata: { ...message.metadata } }
          : message
      );
      change(messages);
      return messages;
    };

    expect(settleRowContexts(settled, copy())).toBe(settled);
    // What a context does not depend on: the text of a reply that has text, its thinking.
    expect(
      settleRowContexts(
        settled,
        copy((messages) => {
          messages[1].content[0] = { type: 'text', text: 'Checking the build.' };
          messages[5].content.unshift({ type: 'thinking', thinking: 'All good.', signature: '' });
        })
      )
    ).toBe(settled);

    const differences: Record<string, (messages: Message[]) => void> = {
      'a reply hidden from the user': (messages) => {
        messages[1].metadata.userVisible = false;
      },
      'another model answered': (messages) => {
        messages[1].metadata.inference = qwen('qwen-c');
      },
      'another model was asked for': (messages) => {
        messages[1].metadata.inference = { provider: 'local', requestedModel: 'other' };
      },
      'a reply that now has text': (messages) => {
        messages[3].content.unshift({ type: 'text', text: 'Building.' });
      },
      'another call': (messages) => {
        messages[3].content = [request('t9')];
      },
      'one more call': (messages) => {
        messages[5].content.push(request('t3'));
      },
      'a later result for a call': (messages) => {
        messages[5].content.push(response('t2', true));
      },
      'one message fewer': (messages) => {
        messages.pop();
      },
    };

    for (const [name, change] of Object.entries(differences)) {
      const messages = copy(change);
      const fromScratch = deriveMessageRowContexts(messages);
      // The difference is one that shows in the contexts...
      expect(fromScratch, name).not.toEqual(settled.contexts);
      // ...and it is not missed.
      const after = settleRowContexts(settled, messages);
      expect(after, name).not.toBe(settled);
      expect(after.contexts, name).toEqual(fromScratch);
    }
  });

  it('is never different from working them out from scratch', () => {
    // A small generator with a fixed seed: the same runs every time.
    const random = (seed: number) => () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const models: Inference[] = [
      { provider: 'local', requestedModel: 'qwen', resolvedModel: 'qwen-a' },
      { provider: 'local', requestedModel: 'qwen', resolvedModel: 'qwen-b' },
      { provider: 'local', requestedModel: 'qwen' },
      { provider: 'local', requestedModel: 'other' },
    ];
    let kept = 0;
    let workedOut = 0;

    for (let seed = 1; seed <= 12; seed++) {
      const next = random(seed);
      const pick = <T>(items: T[]): T => items[Math.floor(next() * items.length)];
      const id = start(`settled-random-${seed}`);
      let settled: SettledRowContexts | undefined;
      let assistant = 0;
      let result = 0;
      let calls = 0;
      let questions = 0;
      const open: string[] = [];
      const asked: AcpPermissionRequest[] = [];

      const check = (messages: Message[]) => {
        const after = settleRowContexts(settled, messages);
        if (after === settled) kept++;
        else workedOut++;
        expect(after.contexts).toEqual(deriveMessageRowContexts(messages));
        settled = after;
      };

      check(apply(chunk('user_message_chunk', id, 'u0', 'go')));
      for (let step = 0; step < 250; step++) {
        const roll = next();
        const messageId = `a${assistant}`;
        if (roll < 0.34) {
          // Text into the reply, sometimes only whitespace, sometimes with its model.
          const text = next() < 0.15 ? '  ' : 'word ';
          const model = next() < 0.3 ? pick(models) : undefined;
          check(apply(chunk('agent_message_chunk', id, messageId, text, model)));
        } else if (roll < 0.52) {
          check(apply(chunk('agent_thought_chunk', id, messageId, 'think ')));
        } else if (roll < 0.66) {
          const toolCallId = `t${calls++}`;
          open.push(toolCallId);
          check(apply(toolCall(id, messageId, toolCallId)));
        } else if (roll < 0.8 && open.length > 0) {
          const toolCallId = open.splice(Math.floor(next() * open.length), 1)[0];
          check(apply(toolResult(id, `r${result}`, toolCallId, next() < 0.3)));
          if (open.length === 0) {
            // The results are in: the next reply is a new message.
            result++;
            assistant++;
          }
        } else if (roll < 0.85 && open.length > 0) {
          const request = permissionRequest(id, pick(open));
          asked.push(request);
          check(acpChatSessionActions.applyPermissionRequest(request).messages);
        } else if (roll < 0.88 && asked.length > 0) {
          const request = asked.pop()!;
          const cancelled = acpChatSessionActions.cancelPermissionRequest(
            id,
            request.request.toolCall.toolCallId,
            request.generation
          );
          if (cancelled) check(cancelled.messages);
        } else if (roll < 0.91) {
          const elicitationId = `q${questions++}`;
          check(
            acpChatSessionActions.applyElicitationRequest({
              id: elicitationId,
              sessionId: id,
              request: {
                mode: 'form',
                sessionId: id,
                message: 'Which one?',
                requestedSchema: { type: 'object', properties: {} },
              },
            }).messages
          );
          if (next() < 0.5) {
            const answered = acpChatSessionActions.setElicitationStatus(
              id,
              elicitationId,
              next() < 0.5 ? 'submitted' : 'cancelled'
            );
            if (answered) check(answered.messages);
          }
          assistant++;
        } else if (roll < 0.95) {
          check(
            acpChatSessionActions.applyAcpGooseSessionNotification(
              gooseUpdate(id, {
                sessionUpdate: 'message_usage',
                messageId,
                usage: { inputTokens: 10, outputTokens: step, totalTokens: 10 + step },
              })
            ).messages
          );
        } else if (roll < 0.98) {
          check(
            acpChatSessionActions.applyAcpGooseSessionNotification(
              gooseUpdate(id, {
                sessionUpdate: 'status_message',
                status: { type: 'notice', message: 'Compacted the conversation.' },
              })
            ).messages
          );
          assistant++;
        } else {
          assistant++;
          check(apply(chunk('user_message_chunk', id, `u${step}`, 'and then?')));
        }
      }
    }

    // Both ways were taken, and often.
    expect(kept).toBeGreaterThan(500);
    expect(workedOut).toBeGreaterThan(500);
  });
});
