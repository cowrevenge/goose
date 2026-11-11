import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import type { IpcRendererEvent } from 'electron';
import type { ImageData, InferenceMetadata, Message, MessageContent } from '../types/message';
import { AppEvents } from '../constants/events';
import { IntlTestWrapper } from '../i18n/test-utils';
import MessageList from './MessageList';

const renderCounts = vi.hoisted(() => new Map<string, number>());
const messageUpdateCallbacks = vi.hoisted(
  () =>
    new Map<
      string,
      | ((
          messageId: string,
          newContent: string,
          editType: 'fork' | 'edit',
          retainedImages: ImageData[]
        ) => void)
      | undefined
    >()
);

vi.mock('./GooseMessage', () => ({
  default: ({ message }: { message: Message }) => {
    const id = message.id ?? 'missing-id';
    renderCounts.set(id, (renderCounts.get(id) ?? 0) + 1);
    return <div>{id}</div>;
  },
}));

// Inside a turn the messages are drawn as text and as rows of tool calls, not as whole
// messages. These two are what those draw with: the text of a note, and an opened call's card.
vi.mock('./MarkdownContent', () => ({
  default: ({ content }: { content: string }) => {
    renderCounts.set(content, (renderCounts.get(content) ?? 0) + 1);
    return <div>{content}</div>;
  },
}));

vi.mock('./ToolCallWithResponse', () => ({
  default: ({ toolRequest }: { toolRequest: { id: string } }) => {
    renderCounts.set(toolRequest.id, (renderCounts.get(toolRequest.id) ?? 0) + 1);
    return <div>card {toolRequest.id}</div>;
  },
}));

vi.mock('./UserMessage', () => ({
  default: ({
    message,
    onMessageUpdate,
  }: {
    message: Message;
    onMessageUpdate?: (
      messageId: string,
      newContent: string,
      editType: 'fork' | 'edit',
      retainedImages: ImageData[]
    ) => void;
  }) => {
    const id = message.id ?? 'missing-id';
    renderCounts.set(id, (renderCounts.get(id) ?? 0) + 1);
    messageUpdateCallbacks.set(id, onMessageUpdate);
    return <div>{id}</div>;
  },
}));

const visibleMetadata: Message['metadata'] = { agentVisible: true, userVisible: true };
const append = vi.fn();
const isUserMessage = (message: Message) => message.role === 'user';

function message(id: string, role: Message['role'], content: MessageContent[]): Message {
  return { id, role, created: 1, content, metadata: visibleMetadata };
}

function cloneMessages(messages: Message[]): Message[] {
  return messages.map((item) => ({
    ...item,
    content: item.content.map((content) => ({ ...content })),
    metadata: { ...item.metadata },
  }));
}

function toolRequest(id: string): MessageContent {
  return {
    type: 'toolRequest',
    id,
    toolCall: {
      status: 'success',
      value: { name: 'test_tool', arguments: {} },
    },
  };
}

function toolResponse(id: string, isError = false): MessageContent {
  return {
    type: 'toolResponse',
    id,
    toolResult: {
      status: 'success',
      value: { content: [{ type: 'text', text: 'complete' }], isError },
    },
  };
}

function renderList(messages: Message[]) {
  return render(
    <MessageList
      messages={messages}
      sessionId="test-session"
      append={append}
      isUserMessage={isUserMessage}
    />,
    { wrapper: IntlTestWrapper }
  );
}

beforeEach(() => {
  vi.mocked(window.electron.on).mockClear();
  vi.mocked(window.electron.off).mockClear();
});

describe('MessageList render isolation', () => {
  beforeEach(() => {
    renderCounts.clear();
    messageUpdateCallbacks.clear();
    append.mockClear();
  });

  it('does not rerender historical rows from cloned equivalent messages', () => {
    const messages = [
      message('assistant-1', 'assistant', [{ type: 'text', text: 'First' }]),
      message('user-1', 'user', [{ type: 'text', text: 'Continue' }]),
      message('assistant-2', 'assistant', [{ type: 'text', text: 'Streaming' }]),
    ];
    const { rerender } = renderList(messages);

    rerender(
      <MessageList
        messages={cloneMessages(messages)}
        sessionId="test-session"
        append={append}
        isUserMessage={isUserMessage}
      />
    );

    expect(renderCounts).toEqual(
      new Map([
        ['assistant-1', 1],
        ['user-1', 1],
        ['assistant-2', 1],
      ])
    );

    const updatedMessages = cloneMessages(messages);
    updatedMessages[2].content = [{ type: 'text', text: 'Streaming update' }];
    rerender(
      <MessageList
        messages={updatedMessages}
        sessionId="test-session"
        append={append}
        isUserMessage={isUserMessage}
      />
    );

    expect(renderCounts).toEqual(
      new Map([
        ['assistant-1', 1],
        ['user-1', 1],
        ['assistant-2', 2],
      ])
    );
  });

  it('rerenders the matching request row when a tool response arrives', () => {
    const messages = [
      message('tool-request', 'assistant', [toolRequest('tool-1')]),
      message('unrelated', 'assistant', [{ type: 'text', text: 'Unrelated' }]),
      message('tool-response', 'user', []),
    ];
    const { rerender } = renderList(messages);
    // The request is a row of the turn; open the row and the call so its card is drawn.
    act(() => screen.getByRole('button', { name: /Used test_tool/ }).click());
    act(() => within(screen.getByTestId('turn-run')).getAllByRole('button')[1].click());
    expect(renderCounts.get('tool-1')).toBe(1);
    const updatedMessages = cloneMessages(messages);
    updatedMessages[2].content = [toolResponse('tool-1')];

    rerender(
      <MessageList
        messages={updatedMessages}
        sessionId="test-session"
        append={append}
        isUserMessage={isUserMessage}
      />
    );

    expect(renderCounts.get('tool-1')).toBe(2);
    expect(renderCounts.get('Unrelated')).toBe(1);
  });

  it('preserves the message update callback', () => {
    const onMessageUpdate = vi.fn();
    render(
      <MessageList
        messages={[message('user-1', 'user', [{ type: 'text', text: 'Original' }])]}
        sessionId="test-session"
        append={append}
        isUserMessage={isUserMessage}
        onMessageUpdate={onMessageUpdate}
      />,
      { wrapper: IntlTestWrapper }
    );
    const retainedImages: ImageData[] = [{ data: 'image', mimeType: 'image/png' }];

    messageUpdateCallbacks.get('user-1')?.('user-1', 'Updated', 'fork', retainedImages);

    expect(onMessageUpdate).toHaveBeenCalledWith('user-1', 'Updated', 'fork', retainedImages);
  });
});

describe('MessageList model change disclosure', () => {
  function assistantWithModel(id: string, inference: InferenceMetadata): Message {
    return {
      ...message(id, 'assistant', [{ type: 'text', text: id }]),
      metadata: { ...visibleMetadata, inference },
    };
  }

  it('labels models that the provider did not confirm as requested', () => {
    renderList([
      assistantWithModel('assistant-1', { provider: 'test', requestedModel: 'model-a' }),
      message('user-1', 'user', [{ type: 'text', text: 'Switch model' }]),
      assistantWithModel('assistant-2', { provider: 'test', requestedModel: 'model-b' }),
    ]);

    expect(
      screen.getByText('Model changed: model-a (requested) → model-b (requested)')
    ).toBeInTheDocument();
  });

  it('shows a resolved model without the requested label', () => {
    renderList([
      assistantWithModel('assistant-1', {
        provider: 'test',
        requestedModel: 'model-a',
        resolvedModel: 'model-a-2026-01-01',
      }),
      message('user-1', 'user', [{ type: 'text', text: 'Switch model' }]),
      assistantWithModel('assistant-2', { provider: 'test', requestedModel: 'model-b' }),
    ]);

    expect(
      screen.getByText('Model changed: model-a-2026-01-01 → model-b (requested)')
    ).toBeInTheDocument();
  });

  it('does not report a change when only the resolved model is missing', () => {
    renderList([
      assistantWithModel('assistant-1', {
        provider: 'test',
        requestedModel: 'model-a',
        resolvedModel: 'model-a-2026-01-01',
      }),
      message('user-1', 'user', [{ type: 'text', text: 'Continue' }]),
      assistantWithModel('assistant-2', { provider: 'test', requestedModel: 'model-a' }),
      message('user-2', 'user', [{ type: 'text', text: 'Continue' }]),
      assistantWithModel('assistant-3', {
        provider: 'test',
        requestedModel: 'model-a',
        resolvedModel: 'model-a-2026-01-01',
      }),
    ]);

    expect(screen.queryByText(/Model changed/)).toBeNull();
  });

  it('compares a resolved model with the last resolved one after a reply without one', () => {
    renderList([
      assistantWithModel('assistant-1', {
        provider: 'test',
        requestedModel: 'model-a',
        resolvedModel: 'model-a-2026-01-01',
      }),
      message('user-1', 'user', [{ type: 'text', text: 'Continue' }]),
      assistantWithModel('assistant-2', { provider: 'test', requestedModel: 'model-a' }),
      message('user-2', 'user', [{ type: 'text', text: 'Continue' }]),
      assistantWithModel('assistant-3', {
        provider: 'test',
        requestedModel: 'model-a',
        resolvedModel: 'model-a-2026-02-01',
      }),
    ]);

    expect(
      screen.getByText('Model changed: model-a-2026-01-01 → model-a-2026-02-01')
    ).toBeInTheDocument();
  });
});

describe('MessageList transcript window', () => {
  function messages(count: number): Message[] {
    return Array.from({ length: count }, (_, index) =>
      message(`assistant-${index}`, 'assistant', [{ type: 'text', text: `Message ${index}` }])
    );
  }

  it('renders the latest messages immediately and hides the middle', () => {
    renderList(messages(500));

    expect(screen.queryByText('assistant-0')).not.toBeNull();
    expect(screen.queryByText('assistant-19')).not.toBeNull();
    expect(screen.queryByText('assistant-20')).toBeNull();
    expect(screen.queryByText('assistant-299')).toBeNull();
    expect(screen.queryByText('assistant-300')).not.toBeNull();
    expect(screen.queryByText('assistant-499')).not.toBeNull();
    expect(screen.queryByText('280 messages hidden')).not.toBeNull();
  });

  it('counts and windows visible messages', () => {
    const transcript = messages(300).map((item, index) =>
      index >= 100 && index < 160
        ? { ...item, metadata: { ...item.metadata, userVisible: false } }
        : item
    );

    renderList(transcript);

    expect(screen.queryByText('assistant-20')).toBeNull();
    expect(screen.queryByText('assistant-39')).toBeNull();
    expect(screen.queryByText('assistant-40')).not.toBeNull();
    expect(screen.queryByText('assistant-100')).toBeNull();
    expect(screen.queryByText('20 messages hidden')).not.toBeNull();
  });

  it('renders the full conversation when requested', () => {
    renderList(messages(221));

    expect(screen.queryByText('assistant-20')).toBeNull();

    act(() => screen.getByRole('button', { name: 'Show all' }).click());

    expect(screen.queryByText('assistant-20')).not.toBeNull();
    expect(screen.queryByText(/message hidden/)).toBeNull();
  });

  it('renders the full conversation when search opens from the keyboard', () => {
    renderList(messages(221));

    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', metaKey: true })));

    expect(screen.queryByText('assistant-20')).not.toBeNull();
  });

  it('renders the full conversation when search opens from the menu', () => {
    renderList(messages(221));
    const findHandler = vi
      .mocked(window.electron.on)
      .mock.calls.find(([event]) => event === 'find-command')?.[1];

    act(() => findHandler?.({} as IpcRendererEvent));

    expect(screen.queryByText('assistant-20')).not.toBeNull();
  });

  it('uses the hidden messages when deriving row context', () => {
    const transcript = messages(221).map((item, index) => ({
      ...item,
      metadata: {
        ...item.metadata,
        inference: {
          provider: 'test',
          requestedModel: 'test-model',
          resolvedModel: index < 20 ? 'old-model' : 'new-model',
        },
      },
    }));

    renderList(transcript);

    expect(screen.queryByText('Model changed: old-model → new-model')).toBeNull();
  });
});

describe('MessageList turn layout', () => {
  const runRows = () => screen.queryAllByTestId('turn-run');
  const rowButton = (run: HTMLElement) => within(run).getAllByRole('button')[0];

  it('folds the calls of a turn into a row and keeps the answer in view', () => {
    const transcript: Message[] = [
      message('u1', 'user', [{ type: 'text', text: 'Check the DB' }]),
      { ...message('a1', 'assistant', [toolRequest('t1')]), created: 10 },
      message('r1', 'user', [toolResponse('t1')]),
      { ...message('a2', 'assistant', [toolRequest('t2'), toolRequest('t3')]), created: 20 },
      message('r2', 'user', [toolResponse('t2'), toolResponse('t3')]),
      { ...message('a3', 'assistant', [{ type: 'text', text: 'Found it.' }]), created: 45 },
    ];

    renderList(transcript);

    // One row for the three calls; the messages behind them are not drawn as messages.
    expect(runRows()).toHaveLength(1);
    expect(rowButton(runRows()[0])).toHaveTextContent('Used 3 tools');
    expect(rowButton(runRows()[0])).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('a1')).toBeNull();
    expect(screen.queryByText('a2')).toBeNull();
    // The answer is a message of its own, outside the turn's rows.
    expect(screen.getByText('a3').closest('[data-testid="turn"]')).toBeNull();

    act(() => rowButton(runRows()[0]).click());
    expect(rowButton(runRows()[0])).toHaveAttribute('aria-expanded', 'true');
    expect(within(runRows()[0]).getAllByText('Used test_tool')).toHaveLength(3);
    // Opened one layer at a time: no call's card yet.
    expect(screen.queryByText(/^card /)).toBeNull();
  });

  it('keeps longer text between calls in view and starts a new row after it', () => {
    const explanation =
      'The table is there but the index is missing. That is why the query is slow. I will add it and run the query again to compare.';
    renderList([
      message('u1', 'user', [{ type: 'text', text: 'Why is it slow?' }]),
      message('a1', 'assistant', [toolRequest('t1')]),
      message('r1', 'user', [toolResponse('t1')]),
      message('a2', 'assistant', [{ type: 'text', text: explanation }, toolRequest('t2')]),
      message('r2', 'user', [toolResponse('t2')]),
      message('a3', 'assistant', [{ type: 'text', text: 'Fast now.' }]),
    ]);

    expect(runRows()).toHaveLength(2);
    expect(screen.getByText(explanation)).toBeInTheDocument();
    // In reading order: row, text, row.
    const turn = screen.getByTestId('turn');
    expect(turn.textContent).toMatch(/Used test_tool.*index is missing.*Used test_tool/s);
  });

  it("folds a reply's thinking into a row above it, unless thinking is set to Never", async () => {
    const thought: MessageContent = { type: 'thinking', thinking: 'hmm', signature: '' };
    renderList([
      message('u1', 'user', [{ type: 'text', text: 'hi' }]),
      { ...message('a1', 'assistant', [thought, { type: 'text', text: 'hello' }]), created: 10 },
    ]);
    expect(screen.getByRole('button', { name: 'Thought' })).toBeInTheDocument();

    await window.electron.setSetting('showThinking', 'never');
    act(() => {
      window.dispatchEvent(new CustomEvent(AppEvents.SHOW_THINKING_CHANGED));
    });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Thought' })).toBeNull());
    expect(screen.getByText('a1')).toBeInTheDocument();

    // "Always" puts the thinking itself in view.
    await window.electron.setSetting('showThinking', 'always');
    act(() => {
      window.dispatchEvent(new CustomEvent(AppEvents.SHOW_THINKING_CHANGED));
    });
    expect(await screen.findByText('hmm')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Thought' })).toBeNull();

    await window.electron.setSetting('showThinking', 'collapsed');
    act(() => {
      window.dispatchEvent(new CustomEvent(AppEvents.SHOW_THINKING_CHANGED));
    });
    expect(await screen.findByRole('button', { name: 'Thought' })).toBeInTheDocument();
  });

  it('says what the turn is doing in the row it is working in', () => {
    render(
      <MessageList
        messages={[
          message('u1', 'user', [{ type: 'text', text: 'go' }]),
          { ...message('a1', 'assistant', [toolRequest('t1')]), created: Date.now() / 1000 - 5 },
        ]}
        sessionId="test-session"
        append={append}
        isUserMessage={isUserMessage}
        isStreamingMessage
      />,
      { wrapper: IntlTestWrapper }
    );
    expect(rowButton(runRows()[0])).toHaveTextContent('Using test_tool…');
  });

  it('stops saying it is at work while it waits for the user to approve a call', () => {
    const confirmation = {
      type: 'toolConfirmationRequest',
      id: 't2',
      toolName: 'test_tool',
      arguments: {},
    } as MessageContent;
    const waiting = (isWaitingForUser: boolean) => (
      <MessageList
        messages={[
          message('u1', 'user', [{ type: 'text', text: 'go' }]),
          message('a1', 'assistant', [toolRequest('t1')]),
          message('r1', 'user', [toolResponse('t1')]),
          { ...message('a2', 'assistant', [toolRequest('t2')]), created: Date.now() / 1000 - 5 },
          message('c1', 'assistant', [confirmation]),
        ]}
        sessionId="test-session"
        append={append}
        isUserMessage={isUserMessage}
        isStreamingMessage
        isWaitingForUser={isWaitingForUser}
      />
    );
    const { rerender } = render(waiting(true), { wrapper: IntlTestWrapper });

    // What it did so far, and the call that asks as its card in view.
    expect(rowButton(runRows()[0])).toHaveTextContent('Used test_tool');
    expect(rowButton(runRows()[0])).toHaveTextContent('Waiting for you');
    expect(rowButton(runRows()[0])).not.toHaveTextContent('…');
    expect(screen.getByText('card t2')).toBeInTheDocument();

    // Answered: the turn is at work again, in that call.
    rerender(waiting(false));
    expect(rowButton(runRows()[0])).toHaveTextContent('Using test_tool…');
    expect(rowButton(runRows()[0])).not.toHaveTextContent('Waiting for you');
    expect(screen.queryByText('card t2')).toBeNull();
  });

  it('has no errors switch when nothing failed', () => {
    renderList([
      message('u1', 'user', [{ type: 'text', text: 'go' }]),
      message('a1', 'assistant', [toolRequest('t1')]),
      message('r1', 'user', [toolResponse('t1')]),
      message('a2', 'assistant', [{ type: 'text', text: 'done' }]),
    ]);
    expect(screen.queryByTestId('errors-only-toggle')).toBeNull();
  });

  it('shows only the failed calls of the session when asked', () => {
    renderList([
      message('u1', 'user', [{ type: 'text', text: 'first' }]),
      message('a1', 'assistant', [toolRequest('t1')]),
      message('r1', 'user', [toolResponse('t1')]),
      message('a2', 'assistant', [{ type: 'text', text: 'clean answer' }]),
      message('u2', 'user', [{ type: 'text', text: 'second' }]),
      message('b1', 'assistant', [toolRequest('t2'), toolRequest('t3'), toolRequest('t4')]),
      message('s1', 'user', [
        toolResponse('t2', true),
        toolResponse('t3'),
        toolResponse('t4', true),
      ]),
      message('b2', 'assistant', [{ type: 'text', text: 'failed answer' }]),
    ]);

    const toggle = screen.getByTestId('errors-only-toggle');
    expect(toggle.textContent).toContain('2 failed calls');
    expect(runRows()).toHaveLength(2);
    expect(screen.getByText('a2')).toBeTruthy();

    act(() => toggle.click());

    // Only the row with failures is left, opened, listing its failed calls alone.
    expect(runRows()).toHaveLength(1);
    expect(screen.queryByText('u1')).toBeNull();
    expect(screen.queryByText('a2')).toBeNull();
    expect(screen.queryByText('b2')).toBeNull();
    expect(rowButton(runRows()[0])).toHaveAttribute('aria-expanded', 'true');
    expect(within(runRows()[0]).getAllByText('Used test_tool')).toHaveLength(2);

    act(() => screen.getByTestId('errors-only-toggle').click());
    expect(runRows()).toHaveLength(2);
    expect(screen.getByText('a2')).toBeTruthy();
  });
});
