import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { IntlTestWrapper } from '../i18n/test-utils';
import type { Message, MessageContent } from '../types/message';
import MessageList from './MessageList';

// A whole turn with the real components (nothing mocked): this is what breaks first when
// upstream changes a message component under the turn layout.

const meta: Message['metadata'] = { agentVisible: true, userVisible: true };
const msg = (id: string, role: Message['role'], created: number, content: MessageContent[]) =>
  ({ id, role, created, content, metadata: meta }) as Message;
const thinking = (text: string): MessageContent => ({
  type: 'thinking',
  thinking: text,
  signature: '',
});
const call = (id: string, name: string, args: Record<string, unknown>): MessageContent => ({
  type: 'toolRequest',
  id,
  toolCall: { status: 'success', value: { name, arguments: args } },
});
const result = (id: string, output: string): MessageContent => ({
  type: 'toolResponse',
  id,
  toolResult: {
    status: 'success',
    value: { content: [{ type: 'text', text: output }], isError: false },
  },
});

const explanation =
  'The build fails on a missing import. That is the only error, the rest are warnings. I will add the import and build again.';

const transcript: Message[] = [
  msg('u1', 'user', 1, [{ type: 'text', text: 'Is the build green?' }]),
  msg('a1', 'assistant', 10, [
    thinking('I should run the build first.'),
    { type: 'text', text: 'Let me run the build.' },
    call('t1', 'developer__shell', { command: 'cargo build' }),
  ]),
  msg('r1', 'user', 30, [result('t1', 'error: cannot find type Foo')]),
  msg('a2', 'assistant', 32, [
    { type: 'text', text: explanation },
    call('t2', 'developer__edit', { path: 'src/main.rs' }),
  ]),
  msg('r2', 'user', 34, [result('t2', 'edited')]),
  msg('a3', 'assistant', 35, [
    { type: 'text', text: 'Building again.' },
    call('t3', 'developer__shell', { command: 'cargo build --release' }),
  ]),
  msg('r3', 'user', 44, [result('t3', 'Finished release profile')]),
  msg('a4', 'assistant', 45, [
    thinking('It compiled, so the answer is yes.'),
    { type: 'text', text: 'Yes, the build is green now.' },
  ]),
];

describe('MessageList turn, drawn for real', () => {
  it('lays the turn out as text, one row per run of calls, and the answer', async () => {
    render(
      <MessageList
        messages={transcript}
        sessionId="session"
        isUserMessage={(message) => message.role === 'user'}
      />,
      { wrapper: IntlTestWrapper }
    );
    await act(async () => {});

    const turn = screen.getByTestId('turn');
    const rows = within(turn)
      .getAllByTestId('turn-run')
      .map((run) => within(run).getAllByRole('button')[0]);

    // Top to bottom: the thinking before the first text, that text, the first call, the longer
    // text in view, then one row for the edit and the build (the short note folds in with them).
    expect(rows.map((row) => row.textContent)).toEqual([
      'Thought',
      'Ran a commandcargo build',
      'Edited a file, ran a command',
    ]);
    expect(within(turn).getByText('Let me run the build.')).toBeInTheDocument();
    expect(within(turn).getByText(explanation)).toBeInTheDocument();
    expect(within(turn).queryByText('Building again.')).toBeNull();
    expect(turn.textContent).toMatch(
      /Thought.*Let me run the build\..*Ran a command.*missing import.*Edited a file, ran a command/s
    );

    // The answer is in full, outside the turn's rows, and its thinking is not drawn over it.
    const answer = screen.getByText('Yes, the build is green now.');
    expect(answer.closest('[data-testid="turn"]')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Thinking' })).toBeNull();

    // A row opens to its steps, one line each, in order; the answer's thinking ends the last run.
    fireEvent.click(rows[2]);
    const steps = within(turn.querySelectorAll('.turn-run-steps')[0] as HTMLElement);
    expect(steps.getByText('Edited a file')).toBeInTheDocument();
    expect(steps.getByText('Building again.')).toBeInTheDocument();
    expect(steps.getByText('cargo build --release')).toBeInTheDocument();
    expect(steps.getByRole('button', { name: 'Thinking' })).toBeInTheDocument();
    expect(steps.queryByText('It compiled, so the answer is yes.')).toBeNull();

    // A step opens on its own: the thinking text, then the call's card.
    fireEvent.click(steps.getByRole('button', { name: 'Thinking' }));
    expect(steps.getByText('It compiled, so the answer is yes.')).toBeInTheDocument();

    fireEvent.click(steps.getByText('Ran a command'));
    await act(async () => {});
    expect(steps.getByText(/Shell command: cargo build --release/)).toBeInTheDocument();
  });
});
