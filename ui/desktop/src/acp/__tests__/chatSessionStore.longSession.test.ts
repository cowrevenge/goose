import type { SessionNotification } from '@agentclientprotocol/sdk';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getTextAndImageContent } from '../../types/message';
import type { Session } from '../../types/session';
import {
  acpChatSessionActions,
  acpChatSessionStore,
  useAcpChatSessionSnapshot,
  type AcpChatSessionSnapshot,
} from '../chatSessionStore';
import type { AcpPermissionRequest } from '../permissionRequestTypes';

// What a streamed chunk costs must not grow with the conversation: the store copies the message
// that changed and shares the rest between snapshots. Copying all of them per chunk is what made
// the window of a session that ran for hours stop keeping up with the model.

const update = (sessionId: string, value: object): SessionNotification =>
  ({ sessionId, update: value }) as unknown as SessionNotification;

const userText = (sessionId: string, messageId: string, text: string) =>
  update(sessionId, {
    sessionUpdate: 'user_message_chunk',
    messageId,
    content: { type: 'text', text },
  });

const agentText = (sessionId: string, messageId: string, text: string) =>
  update(sessionId, {
    sessionUpdate: 'agent_message_chunk',
    messageId,
    content: { type: 'text', text },
  });

const agentThought = (sessionId: string, messageId: string, text: string) =>
  update(sessionId, {
    sessionUpdate: 'agent_thought_chunk',
    messageId,
    content: { type: 'text', text },
  });

const toolCall = (sessionId: string, messageId: string, toolCallId: string) =>
  update(sessionId, {
    sessionUpdate: 'tool_call',
    toolCallId,
    title: 'Shell command: cargo build',
    status: 'pending',
    rawInput: { command: 'cargo build' },
    _meta: { goose: { messageId, toolCall: { toolName: 'developer__shell' } } },
  });

const liveOutput = (sessionId: string, toolCallId: string, sequence: number, output: string) =>
  update(sessionId, {
    sessionUpdate: 'tool_call_update',
    toolCallId,
    status: 'in_progress',
    _meta: {
      toolNotification: {
        type: 'live_output',
        params: { sequence, chunks: [{ stream: 'stdout', output }], truncated: false },
      },
    },
  });

const toolLog = (sessionId: string, toolCallId: string, data: string) =>
  update(sessionId, {
    sessionUpdate: 'tool_call_update',
    toolCallId,
    status: 'in_progress',
    _meta: { toolNotification: { type: 'message', params: { level: 'info', data } } },
  });

const toolResult = (
  sessionId: string,
  messageId: string,
  toolCallId: string,
  status: 'completed' | 'failed' = 'completed'
) =>
  update(sessionId, {
    sessionUpdate: 'tool_call_update',
    toolCallId,
    status,
    content: [{ type: 'content', content: { type: 'text', text: 'Finished' } }],
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

const methods = (snapshot: { notifications: { request_id: string; message: unknown }[] }) =>
  snapshot.notifications.map(
    (event) => `${event.request_id} ${(event.message as { method: string }).method}`
  );

describe('acpChatSessionStore, what a long session costs', () => {
  const sessionIds = new Set<string>();
  const start = (id: string): string => {
    sessionIds.add(id);
    acpChatSessionActions.finishSessionLoad(id, { id, name: id } as Session);
    acpChatSessionActions.startPromptAttempt(id, 'attempt-1');
    return id;
  };
  const apply = (notification: SessionNotification) =>
    acpChatSessionActions.applyAcpSessionNotification(notification);

  afterEach(() => {
    for (const id of sessionIds) {
      acpChatSessionActions.deleteSnapshot(id);
    }
    sessionIds.clear();
  });

  it('copies only the message a streamed chunk changes', () => {
    const id = start('sharing-1');
    apply(userText(id, 'u1', 'Is the build green?'));
    apply(agentThought(id, 'a1', 'Run it first.'));
    const before = apply(agentText(id, 'a1', 'Let me'));

    const after = apply(agentText(id, 'a1', ' check.'));

    expect(after.messages).not.toBe(before.messages);
    expect(after.messages).toHaveLength(2);
    // The message that was not touched is the very same object in both snapshots.
    expect(after.messages[0]).toBe(before.messages[0]);
    expect(after.messages[1]).not.toBe(before.messages[1]);
    expect(after.messages[1].content).toEqual([
      { type: 'thinking', thinking: 'Run it first.', signature: '' },
      { type: 'text', text: 'Let me check.' },
    ]);
  });

  it('leaves a snapshot as it was when the conversation goes on', () => {
    const id = start('sharing-2');
    apply(userText(id, 'u1', 'Is the build green?'));
    const before = apply(agentText(id, 'a1', 'Let me'));
    const asTaken = JSON.parse(JSON.stringify(before.messages));

    apply(agentText(id, 'a1', ' check.'));
    apply(toolCall(id, 'a1', 't1'));
    apply(toolResult(id, 'r1', 't1'));
    apply(agentText(id, 'a2', 'It is.'));

    expect(before.messages).toEqual(asTaken);
    expect(acpChatSessionStore.getSnapshot(id)?.messages).toHaveLength(4);
  });

  it('keeps every copy when a new message is added', () => {
    const id = start('sharing-3');
    apply(userText(id, 'u1', 'Is the build green?'));
    apply(agentText(id, 'a1', 'Let me check.'));
    const before = apply(toolCall(id, 'a1', 't1'));

    const withResult = apply(toolResult(id, 'r1', 't1'));
    const withAnswer = apply(agentText(id, 'a2', 'It is.'));

    expect(withResult.messages.slice(0, 2)).toEqual(before.messages);
    expect(withResult.messages[0]).toBe(before.messages[0]);
    expect(withResult.messages[1]).toBe(before.messages[1]);
    expect(withAnswer.messages).toHaveLength(4);
    expect(withAnswer.messages[2]).toBe(withResult.messages[2]);
  });

  it('gives the same list when an update changes no message', () => {
    const id = start('sharing-4');
    apply(userText(id, 'u1', 'Is the build green?'));
    const before = apply(toolCall(id, 'a1', 't1'));

    // Tool output and status are not messages.
    const withOutput = apply(liveOutput(id, 't1', 0, 'Compiling\n'));
    const waiting = acpChatSessionActions.setChatState(id, before.chatState);

    expect(withOutput.messages).toBe(before.messages);
    expect(waiting.messages).toBe(before.messages);
    expect(acpChatSessionStore.getSnapshot(id)?.messages).toBe(before.messages);
  });

  it('keeps the copies of the other messages when an approval card comes and goes', () => {
    const id = start('sharing-5');
    apply(userText(id, 'u1', 'Is the build green?'));
    const before = apply(toolCall(id, 'a1', 't1'));

    const request = permissionRequest(id, 't1');
    const asked = acpChatSessionActions.applyPermissionRequest(request);
    const cancelled = acpChatSessionActions.cancelPermissionRequest(id, 't1', request.generation);

    expect(asked.messages).toHaveLength(3);
    expect(asked.messages[0]).toBe(before.messages[0]);
    expect(asked.messages[1]).toBe(before.messages[1]);
    expect(cancelled?.messages).toEqual(before.messages);
    expect(cancelled?.messages[0]).toBe(before.messages[0]);
    expect(cancelled?.messages[1]).toBe(before.messages[1]);
  });

  it('starts from fresh copies after the messages are set from outside', () => {
    const id = start('sharing-6');
    apply(userText(id, 'u1', 'Is the build green?'));
    const before = apply(agentText(id, 'a1', 'Let me check.'));

    const replaced = acpChatSessionActions.setMessages(id, before.messages.slice(0, 1));
    const after = apply(agentText(id, 'a2', 'Again.'));

    expect(replaced.messages).toEqual(before.messages.slice(0, 1));
    expect(replaced.messages[0]).not.toBe(before.messages[0]);
    expect(after.messages.map((message) => message.id)).toEqual(['u1', 'a2']);
    expect(after.messages[0]).toEqual(before.messages[0]);
  });

  it("lets go of a command's live output once its result is in, and keeps its logs", () => {
    const id = start('sharing-7');
    apply(toolCall(id, 'a1', 't1'));
    apply(toolCall(id, 'a1', 't2'));
    apply(liveOutput(id, 't1', 0, 'Compiling\n'));
    apply(toolLog(id, 't1', 'started'));
    apply(liveOutput(id, 't2', 0, 'Testing\n'));
    const running = apply(liveOutput(id, 't1', 1, 'Finished\n'));
    expect(methods(running)).toEqual([
      't1 goose/live_output',
      't1 notifications/message',
      't2 goose/live_output',
      't1 goose/live_output',
    ]);

    const done = apply(toolResult(id, 'r1', 't1'));

    // The other command is still running: its output is still needed.
    expect(methods(done)).toEqual(['t1 notifications/message', 't2 goose/live_output']);
    expect(methods(apply(toolResult(id, 'r1', 't2', 'failed')))).toEqual([
      't1 notifications/message',
    ]);
  });

  it('gives the same notifications when an update adds none', () => {
    const id = start('sharing-8');
    apply(toolCall(id, 'a1', 't1'));
    const before = apply(liveOutput(id, 't1', 0, 'Compiling\n'));

    const after = apply(agentText(id, 'a2', 'Still building.'));

    expect(after.notifications).toBe(before.notifications);
  });
});

describe('useAcpChatSessionSnapshot, the pace streamed chunks are drawn at', () => {
  const sessionIds = new Set<string>();
  const start = (id: string): string => {
    sessionIds.add(id);
    acpChatSessionActions.finishSessionLoad(id, { id, name: id } as Session);
    acpChatSessionActions.startPromptAttempt(id, 'attempt-1');
    return id;
  };
  const stream = (id: string, text: string) =>
    acpChatSessionActions.applyAcpSessionNotification(agentText(id, 'a1', text));
  const drawnText = (snapshot: AcpChatSessionSnapshot | undefined) =>
    snapshot?.messages.map((message) => getTextAndImageContent(message).textContent).join('|');

  function drawing(id: string) {
    let draws = 0;
    const hook = renderHook(() => {
      draws++;
      return useAcpChatSessionSnapshot(id);
    });
    return { text: () => drawnText(hook.result.current), draws: () => draws, hook };
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    for (const id of sessionIds) {
      acpChatSessionActions.deleteSnapshot(id);
    }
    sessionIds.clear();
  });

  it('draws the first chunk at once, and the ones right behind it together', () => {
    const id = start('pace-1');
    const view = drawing(id);

    act(() => {
      stream(id, 'One');
    });
    expect(view.text()).toBe('One');

    const before = view.draws();
    act(() => {
      stream(id, ' two');
      stream(id, ' three');
      stream(id, ' four');
    });
    // In the store at once, on screen at the next slot.
    expect(drawnText(acpChatSessionStore.getSnapshot(id))).toBe('One two three four');
    expect(view.text()).toBe('One');
    expect(view.draws()).toBe(before);

    act(() => {
      vi.advanceTimersByTime(50);
    });
    expect(view.text()).toBe('One two three four');
    expect(view.draws()).toBe(before + 1);
  });

  it('draws a chunk at once when nothing was drawn for a while', () => {
    const id = start('pace-2');
    const view = drawing(id);
    act(() => {
      stream(id, 'One');
    });

    act(() => {
      vi.advanceTimersByTime(60);
    });
    act(() => {
      stream(id, ' two');
    });

    expect(view.text()).toBe('One two');
  });

  it('draws a change of state at once, with the chunks that were waiting', () => {
    const id = start('pace-3');
    const view = drawing(id);
    act(() => {
      stream(id, 'One');
    });
    act(() => {
      stream(id, ' two');
    });
    expect(view.text()).toBe('One');

    act(() => {
      acpChatSessionActions.finishPromptAttemptIfCurrent(id, 'attempt-1');
    });

    expect(view.text()).toBe('One two');
    expect(view.hook.result.current?.chatState).toBe('idle');
    // Nothing is left to draw later.
    const draws = view.draws();
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(view.draws()).toBe(draws);
  });

  it('draws an approval request at once', () => {
    const id = start('pace-4');
    const view = drawing(id);
    act(() => {
      stream(id, 'One');
    });

    act(() => {
      acpChatSessionActions.applyAcpSessionNotification(toolCall(id, 'a1', 't1'));
      acpChatSessionActions.applyPermissionRequest(permissionRequest(id, 't1'));
    });

    expect(view.hook.result.current?.chatState).toBe('waitingForUserInput');
    expect(view.hook.result.current?.messages).toHaveLength(2);
  });

  it('stops drawing when the view is gone', () => {
    const id = start('pace-5');
    const view = drawing(id);
    act(() => {
      stream(id, 'One');
      stream(id, ' two');
    });
    const draws = view.draws();

    view.hook.unmount();
    act(() => {
      vi.advanceTimersByTime(200);
    });

    expect(view.draws()).toBe(draws);
  });
});
