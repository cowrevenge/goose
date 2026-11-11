import { fireEvent, render, screen, within } from '@testing-library/react';
import { cloneDeep } from 'lodash';
import { IntlProvider } from 'react-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message, MessageContent } from '../types/message';
import { groupIntoTurns, type Run } from '../utils/turnGrouping';
import { deriveMessageRowContexts, type MessageRowContext } from './messageRowContext';
import TurnRun from './TurnRun';

const cardRenders = vi.hoisted(() => new Map<string, number>());

// One messages object for every render, as in the app: a new one would hand every row a new
// intl and redraw it, which is what the last test here is looking for.
const noMessages = {};
function Wrapper({ children }: { children: React.ReactNode }) {
  return (
    <IntlProvider locale="en" defaultLocale="en" messages={noMessages}>
      {children}
    </IntlProvider>
  );
}

vi.mock('./ToolCallWithResponse', () => ({
  default: ({
    toolRequest,
    isPendingApproval,
    isStreamingMessage,
  }: {
    toolRequest: { id: string };
    isPendingApproval: boolean;
    isStreamingMessage: boolean;
  }) => {
    cardRenders.set(toolRequest.id, (cardRenders.get(toolRequest.id) ?? 0) + 1);
    return (
      <div>
        {isPendingApproval ? 'approval card' : 'full card'} {toolRequest.id}
        {isStreamingMessage ? ' (running)' : ''}
      </div>
    );
  },
}));

const meta: Message['metadata'] = { agentVisible: true, userVisible: true };
const msg = (id: string, role: Message['role'], content: MessageContent[], created = 1): Message =>
  ({ id, role, created, content, metadata: meta }) as Message;
const text = (t: string): MessageContent => ({ type: 'text', text: t });
const thinking = (t: string): MessageContent => ({ type: 'thinking', thinking: t, signature: '' });
const call = (id: string, name: string, args: Record<string, unknown> = {}): MessageContent => ({
  type: 'toolRequest',
  id,
  toolCall: { status: 'success', value: { name, arguments: args } },
});
const result = (id: string, isError = false, content: unknown[] = []): MessageContent =>
  ({
    type: 'toolResponse',
    id,
    toolResult: { status: 'success', value: { content, isError } },
  }) as MessageContent;

/** The runs of a transcript's one agent turn, with what TurnRun needs to draw each. */
function runsOf(messages: Message[]) {
  const rowContexts = deriveMessageRowContexts(messages);
  const groups = groupIntoTurns(
    messages.map((message, index) => ({ message, index })),
    {
      isUserMessage: (m) => m.role === 'user',
      isNotification: () => false,
      rowContexts,
    }
  );
  const turn = groups.find((g) => g.kind === 'turn');
  if (!turn || turn.kind !== 'turn') throw new Error('no turn');
  const runs = turn.blocks.filter((block): block is Run => block.kind === 'run');
  return { runs, rowContexts };
}

function draw(
  run: Run,
  rowContexts: readonly MessageRowContext[],
  props: Partial<React.ComponentProps<typeof TurnRun>> = {}
) {
  const element = (extra: Partial<React.ComponentProps<typeof TurnRun>> = {}) => (
    <TurnRun
      run={run}
      live={false}
      startedAt={1}
      sessionId="session"
      append={append}
      toolStates={run.steps.map((step) =>
        step.kind === 'tool' ? rowContexts[step.index].toolStates[step.toolIndex] : undefined
      )}
      toolNotifications={run.steps.map(() => undefined)}
      {...props}
      {...extra}
    />
  );
  return { ...render(element(), { wrapper: Wrapper }), element };
}

const append = vi.fn();
const row = () => within(screen.getByTestId('turn-run')).getAllByRole('button')[0];

const work: Message[] = [
  msg('u1', 'user', [text('fix the build')]),
  msg('a1', 'assistant', [call('t1', 'developer__shell', { command: 'cargo build' })]),
  msg('r1', 'user', [result('t1', true)]),
  msg('a2', 'assistant', [
    thinking('The import is missing.'),
    text('Now the fix.'),
    call('t2', 'developer__edit', { path: 'src/main.rs' }),
    call('t3', 'developer__shell', { command: 'cargo test' }),
  ]),
  msg('r2', 'user', [result('t2'), result('t3')]),
  msg('a3', 'assistant', [text('Fixed.')]),
];

beforeEach(() => cardRenders.clear());

describe('TurnRun', () => {
  it('is one row that says what the run did, in order, with what failed', () => {
    const { runs, rowContexts } = runsOf(work);
    draw(runs[0], rowContexts);

    expect(row()).toHaveTextContent('Ran 2 commands, edited a file');
    expect(row()).toHaveTextContent('1 failed');
    expect(row()).toHaveAttribute('aria-expanded', 'false');
    // Folded: nothing of the steps is drawn.
    expect(screen.queryByText('Now the fix.')).toBeNull();
    expect(screen.queryByText('cargo build')).toBeNull();
  });

  it('opens to its steps one line each, and each step opens on its own', () => {
    const { runs, rowContexts } = runsOf(work);
    draw(runs[0], rowContexts);

    fireEvent.click(row());
    expect(row()).toHaveAttribute('aria-expanded', 'true');
    const steps = screen.getByTestId('turn-run').querySelector('.turn-run-steps') as HTMLElement;
    expect(
      Array.from(steps.children).map((step) => step.textContent?.replace(/\s+/g, ' ').trim())
    ).toEqual([
      'Ran a commandcargo build',
      'Thinking',
      'Now the fix.',
      'Edited a filesrc/main.rs',
      'Ran a commandcargo test',
    ]);
    expect(screen.queryByText(/full card/)).toBeNull();
    expect(screen.queryByText('The import is missing.')).toBeNull();

    fireEvent.click(screen.getByText('Edited a file'));
    expect(screen.getByText('full card t2')).toBeInTheDocument();
    expect(screen.queryByText('full card t1')).toBeNull();

    fireEvent.click(screen.getByText('Thinking'));
    expect(screen.getByText('The import is missing.')).toBeInTheDocument();

    // Shut and opened again, the step that was open is still open.
    fireEvent.click(row());
    expect(steps).toHaveClass('hidden');
    fireEvent.click(row());
    expect(steps).not.toHaveClass('hidden');
    expect(screen.getByText('full card t2')).toBeInTheDocument();
  });

  it('names a single call and what it was on', () => {
    const { runs, rowContexts } = runsOf([
      msg('u1', 'user', [text('look')]),
      msg('a1', 'assistant', [call('t1', 'developer__read', { path: 'src/main.rs' })]),
      msg('r1', 'user', [result('t1')]),
      msg('a2', 'assistant', [text('Read it.')]),
    ]);
    draw(runs[0], rowContexts);
    expect(row()).toHaveTextContent('Read a file');
    expect(row()).toHaveTextContent('src/main.rs');
  });

  it('names a tool it has no word for by its own name', () => {
    const { runs, rowContexts } = runsOf([
      msg('u1', 'user', [text('remember')]),
      msg('a1', 'assistant', [call('t1', 'memory__remember_memory', { data: 'x' })]),
      msg('r1', 'user', [result('t1')]),
      msg('a2', 'assistant', [text('Saved.')]),
    ]);
    draw(runs[0], rowContexts);
    expect(row()).toHaveTextContent('Used remember_memory');
  });

  it('is "Thought" when the run is thinking alone', () => {
    const { runs, rowContexts } = runsOf([
      msg('u1', 'user', [text('hi')]),
      msg('a1', 'assistant', [thinking('hmm'), text('hello')]),
    ]);
    draw(runs[0], rowContexts);
    expect(row()).toHaveTextContent('Thought');
    fireEvent.click(row());
    fireEvent.click(screen.getByText('Thinking'));
    expect(screen.getByText('hmm')).toBeInTheDocument();
  });

  it('says what it is doing right now while the turn is in it', () => {
    const running = [
      msg('u1', 'user', [text('go')]),
      msg('a1', 'assistant', [call('t1', 'developer__read', { path: 'a.rs' })], 100),
      msg('r1', 'user', [result('t1')]),
      msg('a2', 'assistant', [call('t2', 'developer__shell', { command: 'cargo build' })], 105),
    ];
    const { runs, rowContexts } = runsOf(running);
    draw(runs[0], rowContexts, { live: true, startedAt: Date.now() / 1000 - 75 });

    expect(row()).toHaveTextContent('Running a command…');
    expect(row()).toHaveTextContent('cargo build');
    expect(row()).toHaveTextContent(/1m 1\ds/);
    expect(row()).not.toHaveTextContent('Read a file');

    // Opened: the call it is waiting on is still running, the one before it is done.
    fireEvent.click(row());
    const steps = within(
      screen.getByTestId('turn-run').querySelector('.turn-run-steps') as HTMLElement
    );
    fireEvent.click(steps.getByText('Running a command…'));
    expect(steps.getByText('full card t2 (running)')).toBeInTheDocument();
    fireEvent.click(steps.getByText('Read a file'));
    expect(steps.getByText('full card t1')).toBeInTheDocument();
  });

  it('says "Thinking…" while the model is thinking at the end of the run', () => {
    const { runs, rowContexts } = runsOf([
      msg('u1', 'user', [text('go')]),
      msg('a1', 'assistant', [call('t1', 'developer__read', { path: 'a.rs' })]),
      msg('r1', 'user', [result('t1')]),
      msg('a2', 'assistant', [thinking('what next')]),
    ]);
    draw(runs[0], rowContexts, { live: true });
    expect(row()).toHaveTextContent('Thinking…');
  });

  const confirm = (id: string): MessageContent =>
    ({
      type: 'toolConfirmationRequest',
      id,
      toolName: 'developer__shell',
      arguments: {},
    }) as MessageContent;
  const asking: Message[] = [
    msg('u1', 'user', [text('clean up')]),
    msg('a1', 'assistant', [call('t1', 'developer__read', { path: 'a.rs' })]),
    msg('r1', 'user', [result('t1')]),
    msg('a2', 'assistant', [call('t2', 'developer__shell', { command: 'rm -rf build' })]),
    msg('c1', 'assistant', [confirm('t2')]),
  ];

  it('keeps a call that asks for approval out of the row, as its card under it', () => {
    const { runs, rowContexts } = runsOf(asking);
    draw(runs[0], rowContexts);

    // The row says what has been done. The call that asks has not happened: nothing "ran".
    expect(row()).toHaveTextContent('Read a file');
    expect(row()).toHaveTextContent('Waiting for you');
    expect(row()).not.toHaveTextContent(/command/i);
    expect(screen.getByText('approval card t2')).toBeInTheDocument();
    // It is not also a step in the list.
    fireEvent.click(row());
    const steps = screen.getByTestId('turn-run').querySelector('.turn-run-steps') as HTMLElement;
    expect(Array.from(steps.children).map((step) => step.textContent)).toEqual(['Read a filea.rs']);
    expect(screen.getAllByText('approval card t2')).toHaveLength(1);
  });

  it('has no row when all it has is a call that asks for approval', () => {
    const { runs, rowContexts } = runsOf([
      msg('u1', 'user', [text('clean up')]),
      msg('a1', 'assistant', [call('t1', 'developer__shell', { command: 'rm -rf build' })]),
      msg('c1', 'assistant', [confirm('t1')]),
    ]);
    draw(runs[0], rowContexts);

    expect(within(screen.getByTestId('turn-run')).queryByRole('button')).toBeNull();
    expect(screen.getByText('approval card t1')).toBeInTheDocument();
  });

  it('takes the call into the row once the user has answered and the turn works again', () => {
    const { runs, rowContexts } = runsOf(asking);
    draw(runs[0], rowContexts, { live: true, startedAt: Date.now() / 1000 - 5 });

    expect(row()).toHaveTextContent('Running a command…');
    expect(row()).toHaveTextContent('rm -rf build');
    expect(row()).not.toHaveTextContent('Waiting for you');
    expect(screen.queryByText('approval card t2')).toBeNull();
    fireEvent.click(row());
    const steps = screen.getByTestId('turn-run').querySelector('.turn-run-steps') as HTMLElement;
    expect(Array.from(steps.children).map((step) => step.textContent)).toEqual([
      'Read a filea.rs',
      'Running a command…rm -rf build',
    ]);
  });

  it('shows the picture a run made under its row', () => {
    const png = { type: 'image', data: 'AAAA', mimeType: 'image/png' };
    const { runs, rowContexts } = runsOf([
      msg('u1', 'user', [text('draw a fox')]),
      msg('a1', 'assistant', [
        call('t1', 'developer__generate_image', { prompt: 'a red fox in snow' }),
      ]),
      msg('r1', 'user', [result('t1', false, [png])]),
      msg('a2', 'assistant', [text('Here it is.')]),
    ]);
    draw(runs[0], rowContexts);

    expect(row()).toHaveTextContent('Generated an image');
    expect(screen.getByAltText('a red fox in snow')).toHaveAttribute(
      'src',
      'data:image/png;base64,AAAA'
    );
  });

  it('lists only the failed calls, opened, in the errors view', () => {
    const { runs, rowContexts } = runsOf(work);
    draw(runs[0], rowContexts, { forceOpen: true, onlyFailed: true });

    expect(row()).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('cargo build')).toBeInTheDocument();
    expect(screen.queryByText('cargo test')).toBeNull();
    expect(screen.queryByText('Edited a file')).toBeNull();
    expect(screen.queryByText('Thinking')).toBeNull();
    expect(screen.queryByText('Now the fix.')).toBeNull();
  });

  it("draws a recipe's structured result as a plain line, with no card to open", () => {
    const { runs, rowContexts } = runsOf([
      msg('u1', 'user', [text('report')]),
      msg('a1', 'assistant', [call('t1', 'developer__read', { path: 'a.rs' })]),
      msg('r1', 'user', [result('t1')]),
      msg('a2', 'assistant', [call('f1', 'recipe__final_output', { answer: 'done' })]),
      msg('r2', 'user', [result('f1')]),
    ]);
    draw(runs[0], rowContexts);
    fireEvent.click(row());
    expect(screen.getByText('Returned structured result')).toBeInTheDocument();
  });

  it('does not draw again for the same run', () => {
    const { runs, rowContexts } = runsOf(work);
    const { rerender, element } = draw(runs[0], rowContexts);
    fireEvent.click(row());
    fireEvent.click(screen.getByText('Edited a file'));
    expect(cardRenders.get('t2')).toBe(1);

    // The same conversation again, as new objects: nothing in the run changed.
    const again = runsOf(cloneDeep(work));
    rerender(
      element({
        run: again.runs[0],
        toolStates: again.runs[0].steps.map((step) =>
          step.kind === 'tool'
            ? again.rowContexts[step.index].toolStates[step.toolIndex]
            : undefined
        ),
      })
    );
    expect(cardRenders.get('t2')).toBe(1);
  });
});
