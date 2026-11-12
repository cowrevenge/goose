import type { GooseSessionNotification_unstable } from '@aaif/goose-acp-client';
import type { SessionNotification } from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';
import type { Message } from '../../types/message';
import {
  createAcpSessionNotificationAdapter,
  type AcpChatStateChange,
} from '../sessionNotificationAdapter';

// What an update costs the adapter must not grow with the conversation.
//
// It changes its messages in place and says which one it changed, so the store copies that one
// and no other (chatSessionStore: publishMessages). A change that names the wrong message, or
// none when one was changed, would leave the chat showing stale text.
//
// And it looks for the message an update belongs to from the end, where it is, not through the
// whole conversation from the start.

const SESSION_ID = 'session-1';
const update = (value: object): SessionNotification =>
  ({ sessionId: SESSION_ID, update: value }) as unknown as SessionNotification;

function messagesChange(changes: AcpChatStateChange[]) {
  const change = changes.find((item) => item.type === 'messages');
  if (change?.type !== 'messages') {
    throw new Error('expected a messages change');
  }
  return change;
}

const ids = (messages: readonly Message[] | undefined) => messages?.map((message) => message.id);

describe('the adapter in a long session', () => {
  it('names the message a text chunk was added to, and nothing for a new message', () => {
    const adapter = createAcpSessionNotificationAdapter();
    const text = (messageId: string, value: string) =>
      update({
        sessionUpdate: 'agent_message_chunk',
        messageId,
        content: { type: 'text', text: value },
      });

    const first = messagesChange(adapter.apply(text('a1', 'Let me')));
    const second = messagesChange(adapter.apply(text('a1', ' check.')));

    // A new message shows in the list itself.
    expect(first.touched).toEqual([]);
    expect(ids(second.touched)).toEqual(['a1']);
    expect(second.touched?.[0]).toBe(second.messages[0]);
  });

  it('names the message a thought, a tool call and a tool result went into', () => {
    const adapter = createAcpSessionNotificationAdapter();
    adapter.apply(
      update({
        sessionUpdate: 'user_message_chunk',
        messageId: 'u1',
        content: { type: 'text', text: 'Is the build green?' },
      })
    );

    const thought = messagesChange(
      adapter.apply(
        update({
          sessionUpdate: 'agent_thought_chunk',
          messageId: 'a1',
          content: { type: 'text', text: 'Run it.' },
        })
      )
    );
    const call = messagesChange(
      adapter.apply(
        update({
          sessionUpdate: 'tool_call',
          toolCallId: 't1',
          title: 'Shell command',
          status: 'pending',
          _meta: { goose: { messageId: 'a1' } },
        })
      )
    );
    const result = messagesChange(
      adapter.apply(
        update({
          sessionUpdate: 'tool_call_update',
          toolCallId: 't1',
          status: 'completed',
          content: [{ type: 'content', content: { type: 'text', text: 'Finished' } }],
          _meta: { goose: { messageId: 'r1' } },
        })
      )
    );

    expect(ids(thought.touched)).toEqual(['a1']);
    expect(ids(call.touched)).toEqual(['a1']);
    expect(ids(result.touched)).toEqual(['r1']);
    expect(result.touched?.[0]).toBe(result.messages[2]);
  });

  it('names the message a usage report was attached to', () => {
    const adapter = createAcpSessionNotificationAdapter();
    adapter.apply(
      update({
        sessionUpdate: 'agent_message_chunk',
        messageId: 'a1',
        content: { type: 'text', text: 'Done.' },
      })
    );

    const usage = messagesChange(
      adapter.applyGoose({
        sessionId: SESSION_ID,
        update: {
          sessionUpdate: 'message_usage',
          messageId: 'a1',
          usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
        },
      } as unknown as GooseSessionNotification_unstable)
    );

    expect(ids(usage.touched)).toEqual(['a1']);
    expect(usage.messages[0].metadata.usage).toMatchObject({ totalTokens: 12 });
  });

  it('adds a result once, however much came in after it', () => {
    const adapter = createAcpSessionNotificationAdapter();
    const call = (messageId: string, toolCallId: string) =>
      update({
        sessionUpdate: 'tool_call',
        toolCallId,
        title: 'Shell command',
        status: 'pending',
        _meta: { goose: { messageId } },
      });
    const result = (messageId: string, toolCallId: string) =>
      update({
        sessionUpdate: 'tool_call_update',
        toolCallId,
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'Finished' } }],
        _meta: { goose: { messageId } },
      });
    const results = (messages: readonly Message[]) =>
      messages.flatMap((message) =>
        message.content.flatMap((content) =>
          content.type === 'toolResponse' ? [`${message.id}:${content.id}`] : []
        )
      );

    // Two calls in one step: their results go into one message.
    adapter.apply(call('a1', 't1'));
    adapter.apply(call('a1', 't2'));
    adapter.apply(result('r1', 't1'));
    adapter.apply(result('r1', 't2'));
    for (let step = 2; step < 30; step++) {
      adapter.apply(call(`a${step}`, `t${step + 1}`));
      adapter.apply(result(`r${step}`, `t${step + 1}`));
    }

    // The first result again, long after: it is already there.
    const again = messagesChange(adapter.apply(result('r1', 't1')));

    expect(again.touched).toEqual([]);
    expect(results(again.messages).slice(0, 3)).toEqual(['r1:t1', 'r1:t2', 'r2:t3']);
    expect(results(again.messages)).toHaveLength(30);

    // A call that has no result yet gets one, wherever it is.
    adapter.apply(call('a40', 't40'));
    for (let step = 41; step < 60; step++) {
      adapter.apply(call(`a${step}`, `t${step}`));
      adapter.apply(result(`r${step}`, `t${step}`));
    }
    const late = messagesChange(adapter.apply(result('r40', 't40')));

    expect(ids(late.touched)).toEqual(['r40']);
    expect(results(late.messages)).toHaveLength(50);
    expect(results(late.messages).at(-1)).toBe('r40:t40');
  });

  it('finds the message a chunk belongs to among many', () => {
    const adapter = createAcpSessionNotificationAdapter();
    for (let step = 0; step < 50; step++) {
      adapter.apply(
        update({
          sessionUpdate: 'agent_message_chunk',
          messageId: `a${step}`,
          content: { type: 'text', text: `step ${step}` },
        })
      );
      adapter.apply(
        update({
          sessionUpdate: 'user_message_chunk',
          messageId: `u${step}`,
          content: { type: 'text', text: 'go on' },
        })
      );
    }

    // Not the newest message: an earlier one, by its id and its role.
    const change = messagesChange(
      adapter.apply(
        update({
          sessionUpdate: 'agent_message_chunk',
          messageId: 'a7',
          content: { type: 'text', text: ', continued' },
        })
      )
    );

    expect(change.messages).toHaveLength(100);
    expect(ids(change.touched)).toEqual(['a7']);
    expect(change.messages[14].content).toEqual([{ type: 'text', text: 'step 7, continued' }]);
  });
});
