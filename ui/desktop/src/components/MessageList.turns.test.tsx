import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { IntlTestWrapper } from '../i18n/test-utils';
import type { Message, MessageContent } from '../types/message';
import MessageList from './MessageList';

// The whole turn with the real components (nothing mocked): this is what breaks first when
// upstream changes a message component under the turn layout.

const meta: Message['metadata'] = { agentVisible: true, userVisible: true };
const msg = (id: string, role: Message['role'], created: number, content: MessageContent[]) =>
  ({ id, role, created, content, metadata: meta }) as Message;
const thinking = (text: string): MessageContent => ({
  type: 'thinking',
  thinking: text,
  signature: '',
});

const transcript: Message[] = [
  msg('u1', 'user', 1, [{ type: 'text', text: 'Is the build green?' }]),
  msg('a1', 'assistant', 10, [
    thinking('I should run the build first.'),
    { type: 'text', text: 'Let me run the build.' },
    {
      type: 'toolRequest',
      id: 't1',
      toolCall: {
        status: 'success',
        value: { name: 'developer__shell', arguments: { command: 'cargo build' } },
      },
    },
  ]),
  msg('r1', 'user', 30, [
    {
      type: 'toolResponse',
      id: 't1',
      toolResult: {
        status: 'success',
        value: { content: [{ type: 'text', text: 'Finished dev profile' }], isError: false },
      },
    },
  ]),
  msg('a2', 'assistant', 45, [
    thinking('It compiled, so the answer is yes.'),
    { type: 'text', text: 'Yes, the build is green.' },
  ]),
];

describe('MessageList turn, drawn for real', () => {
  it('folds the work into one line and opens it one step at a time', async () => {
    const { container } = render(
      <MessageList
        messages={transcript}
        sessionId="session"
        isUserMessage={(message) => message.role === 'user'}
      />,
      { wrapper: IntlTestWrapper }
    );
    await act(async () => {});

    // Folded: the summary line and the answer.
    const summary = screen.getByRole('button', { name: /Worked for 35s · 1 tool call/ });
    const work = container.querySelector('.turn-work [data-slot="collapsible-content"]')!;
    expect(work.getAttribute('data-state')).toBe('closed');
    expect(screen.getByText('Yes, the build is green.').closest('.turn-work')).toBeNull();

    // Opened: one line per step, both thinking blocks as the same kind of row, nothing expanded.
    fireEvent.click(summary);
    expect(work.getAttribute('data-state')).toBe('open');
    const steps = within(work as HTMLElement);
    expect(steps.getAllByRole('button', { name: 'Thinking' })).toHaveLength(2);
    expect(steps.getByText('Let me run the build.')).toBeInTheDocument();
    expect(steps.getByText('Ran a command')).toBeInTheDocument();
    expect(steps.getByText('cargo build')).toBeInTheDocument();
    expect(steps.queryByText('I should run the build first.')).toBeNull();
    expect(steps.queryByText('It compiled, so the answer is yes.')).toBeNull();

    // A step opens on its own: the thinking text, then the tool's card.
    fireEvent.click(steps.getAllByRole('button', { name: 'Thinking' })[1]);
    expect(steps.getByText('It compiled, so the answer is yes.')).toBeInTheDocument();
    expect(steps.queryByText('I should run the build first.')).toBeNull();

    fireEvent.click(steps.getByText('Ran a command'));
    await act(async () => {});
    expect(steps.getByText(/Shell command: cargo build/)).toBeInTheDocument();
  });
});
