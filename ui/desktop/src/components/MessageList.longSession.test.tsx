import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { Message, MessageContent } from '../types/message';
import { IntlTestWrapper } from '../i18n/test-utils';
import MessageList from './MessageList';
import { deriveMessageRowContexts } from './messageRowContext';
import { groupIntoTurns } from '../utils/turnGrouping';

// What a streamed chunk costs the list must not grow with the conversation. The passes over
// every message (the row contexts, and the errors view's layout of the whole session) are for
// when a call, a result or a message is added, not for text arriving in a reply.

vi.mock('./messageRowContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./messageRowContext')>();
  return { ...actual, deriveMessageRowContexts: vi.fn(actual.deriveMessageRowContexts) };
});

vi.mock('../utils/turnGrouping', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/turnGrouping')>();
  return { ...actual, groupIntoTurns: vi.fn(actual.groupIntoTurns) };
});

vi.mock('./GooseMessage', () => ({
  default: ({ message }: { message: Message }) => (
    <div>
      {message.content.map((content) => (content.type === 'text' ? content.text : '')).join('')}
    </div>
  ),
}));
vi.mock('./MarkdownContent', () => ({
  default: ({ content }: { content: string }) => <div>{content}</div>,
}));
vi.mock('./ToolCallWithResponse', () => ({
  default: ({ toolRequest }: { toolRequest: { id: string } }) => <div>card {toolRequest.id}</div>,
}));
vi.mock('./UserMessage', () => ({
  default: ({ message }: { message: Message }) => <div>{message.id}</div>,
}));

const metadata: Message['metadata'] = { agentVisible: true, userVisible: true };
const message = (id: string, role: Message['role'], content: MessageContent[]): Message => ({
  id,
  role,
  created: 1,
  content,
  metadata,
});
const text = (value: string): MessageContent => ({ type: 'text', text: value });
const call = (id: string): MessageContent => ({
  type: 'toolRequest',
  id,
  toolCall: { status: 'success', value: { name: 'test_tool', arguments: {} } },
});
const result = (id: string, isError = false): MessageContent => ({
  type: 'toolResponse',
  id,
  toolResult: { status: 'success', value: { content: [text('done')], isError } },
});

const settledPart: Message[] = [
  message('u1', 'user', [text('Is the build green?')]),
  message('a1', 'assistant', [text('Let me check.'), call('t1')]),
  message('r1', 'user', [result('t1', true)]),
];
// The reply streaming in: each chunk is the same messages with a new last one.
const streaming = (reply: string, more: MessageContent[] = []): Message[] => [
  ...settledPart,
  message('a2', 'assistant', [text(reply), ...more]),
];

// One function for every render, as the chat view passes it.
const isUserMessage = (item: Message) => item.role === 'user';
const list = (messages: Message[]) => (
  <MessageList
    messages={messages}
    sessionId="test-session"
    isUserMessage={isUserMessage}
    isStreamingMessage
  />
);

describe('MessageList, what a streamed chunk costs', () => {
  beforeEach(() => {
    vi.mocked(deriveMessageRowContexts).mockClear();
    vi.mocked(groupIntoTurns).mockClear();
  });

  it('does not work the row contexts out again while a reply streams in', () => {
    const view = render(list(streaming('It')), { wrapper: IntlTestWrapper });
    expect(deriveMessageRowContexts).toHaveBeenCalledTimes(1);

    view.rerender(list(streaming('It failed')));
    view.rerender(list(streaming('It failed on a missing import.')));

    expect(screen.getByText('It failed on a missing import.')).toBeInTheDocument();
    expect(deriveMessageRowContexts).toHaveBeenCalledTimes(1);

    // A call is something a context is made of.
    expect(screen.getByTestId('turn-run')).toHaveTextContent('Used test_tool');
    view.rerender(list(streaming('It failed on a missing import.', [call('t2')])));
    expect(deriveMessageRowContexts).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('turn-run')).toHaveTextContent('Using test_tool…');
  });

  it('does not lay the whole session out again in the errors view while a reply streams in', () => {
    const view = render(list(streaming('It')), { wrapper: IntlTestWrapper });
    fireEvent.click(screen.getByTestId('errors-only-toggle'));
    expect(screen.getByTestId('turn-run')).toHaveTextContent('1 failed');
    const layouts = vi.mocked(groupIntoTurns).mock.calls.length;

    view.rerender(list(streaming('It failed')));
    view.rerender(list(streaming('It failed on a missing import.')));

    expect(groupIntoTurns).toHaveBeenCalledTimes(layouts);
    expect(screen.getByTestId('turn-run')).toHaveTextContent('1 failed');

    // Another failed call is a change to what the errors view shows.
    view.rerender(
      list([
        ...streaming('It failed on a missing import.', [call('t2')]),
        message('r2', 'user', [result('t2', true)]),
      ])
    );
    expect(vi.mocked(groupIntoTurns).mock.calls.length).toBeGreaterThan(layouts);
    expect(screen.getAllByText('2 failed calls', { exact: false })).not.toHaveLength(0);
  });
});
