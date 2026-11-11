import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../i18n/test-utils';
import type { Message, MessageContent, ToolResponseMessageContent } from '../types/message';
import type { ShowThinking } from '../utils/settings';
import type { ToolRenderState } from './messageRowContext';
import CompactMessage from './CompactMessage';
import GooseMessage from './GooseMessage';
import { TurnWorkOpenContext } from './turnWorkContext';

vi.mock('./ToolCallWithResponse', () => ({
  default: ({ toolRequest }: { toolRequest: { id: string } }) => (
    <div>full card {toolRequest.id}</div>
  ),
}));

const call = (id: string, name: string, args: Record<string, unknown>): MessageContent => ({
  type: 'toolRequest',
  id,
  toolCall: { status: 'success', value: { name, arguments: args } },
});
const response = (id: string, isError: boolean): ToolResponseMessageContent => ({
  type: 'toolResponse',
  id,
  toolResult: { status: 'success', value: { content: [], isError } },
});
const state = (id: string, isError: boolean): ToolRenderState =>
  ({ requestId: id, response: response(id, isError), isPending: false }) as ToolRenderState;

function assistant(content: MessageContent[]): Message {
  return {
    content,
    created: 1,
    metadata: { agentVisible: true, userVisible: true },
    role: 'assistant',
  };
}

function steps(onlyFailed = false) {
  return (
    <CompactMessage
      sessionId="session"
      message={assistant([
        { type: 'thinking', thinking: 'Working it out', signature: '' },
        { type: 'text', text: 'Let me check the build.' },
        call('t1', 'developer__shell', { command: 'cargo build' }),
        call('t2', 'developer__read', { path: 'src/main.rs' }),
      ])}
      toolStates={[state('t1', true), state('t2', false)]}
      toolNotifications={[undefined, undefined]}
      toolConfirmationShownInline={false}
      append={vi.fn()}
      isStreaming={false}
      onlyFailed={onlyFailed}
    />
  );
}

function renderSteps(onlyFailed = false) {
  return render(steps(onlyFailed), { wrapper: IntlTestWrapper });
}

function setShowThinking(value: ShowThinking) {
  return window.electron.setSetting('showThinking', value);
}

describe('CompactMessage', () => {
  afterEach(() => setShowThinking('collapsed'));

  it('draws every step on one line, opened one at a time', async () => {
    renderSteps();

    expect(await screen.findByText('Thinking')).toBeInTheDocument();
    expect(screen.queryByText('Working it out')).toBeNull();
    expect(screen.getByText('Let me check the build.')).toBeInTheDocument();
    expect(screen.getByText('Ran a command')).toBeInTheDocument();
    expect(screen.getByText('cargo build')).toBeInTheDocument();
    expect(screen.getByText('Read a file')).toBeInTheDocument();
    expect(screen.getByText('src/main.rs')).toBeInTheDocument();
    expect(screen.queryByText('full card t1')).toBeNull();

    fireEvent.click(screen.getByText('Ran a command'));
    expect(screen.getByText('full card t1')).toBeInTheDocument();
    expect(screen.queryByText('full card t2')).toBeNull();

    fireEvent.click(screen.getByText('Thinking'));
    expect(screen.getByText('Working it out')).toBeInTheDocument();
  });

  it('lists thinking already open when the setting is Always', async () => {
    await setShowThinking('always');
    renderSteps();

    expect(await screen.findByText('Working it out')).toBeInTheDocument();
    // Still a step that can be shut, and the tool calls stay one line each.
    fireEvent.click(screen.getByText('Thinking'));
    expect(screen.queryByText('Working it out')).toBeNull();
    expect(screen.queryByText('full card t1')).toBeNull();
  });

  it('draws always-open thinking only while its turn is unfolded', async () => {
    await setShowThinking('always');
    const inTurn = (open: boolean) => (
      <TurnWorkOpenContext.Provider value={open}>{steps()}</TurnWorkOpenContext.Provider>
    );
    const { rerender } = render(inTurn(false), { wrapper: IntlTestWrapper });

    // Give the setting time to arrive: the step is listed, its text is not drawn.
    await act(async () => {});
    expect(screen.getByText('Thinking')).toBeInTheDocument();
    expect(screen.queryByText('Working it out')).toBeNull();

    rerender(inTurn(true));
    expect(screen.getByText('Working it out')).toBeInTheDocument();
  });

  it('does not list thinking when the setting is Never', async () => {
    await setShowThinking('never');
    renderSteps();

    await waitFor(() => expect(screen.queryByText('Thinking')).toBeNull());
    expect(screen.queryByText('Working it out')).toBeNull();
    expect(screen.getByText('Let me check the build.')).toBeInTheDocument();
    expect(screen.getByText('Ran a command')).toBeInTheDocument();
  });

  it('shows the image call as one row; the picture itself is shown by the turn', () => {
    const done = {
      requestId: 'g1',
      response: {
        type: 'toolResponse',
        id: 'g1',
        toolResult: {
          status: 'success',
          value: {
            content: [
              { type: 'text', text: 'Generated a 1024x1024 image.' },
              { type: 'image', data: 'AAAA', mimeType: 'image/png' },
            ],
            isError: false,
          },
        },
      },
      confirmation: undefined,
      isPending: false,
    } as unknown as ToolRenderState;
    render(
      <CompactMessage
        sessionId="session"
        message={assistant([
          call('g1', 'developer__generate_image', { prompt: 'a red fox in snow' }),
        ])}
        toolStates={[done]}
        toolNotifications={[undefined]}
        toolConfirmationShownInline={false}
        append={vi.fn()}
        isStreaming={false}
      />,
      { wrapper: IntlTestWrapper }
    );

    expect(screen.getByText('Generated an image')).toBeInTheDocument();
    expect(screen.getByText('a red fox in snow')).toBeInTheDocument();
    // The turn shows the picture outside its fold (MessageList), so the folded row must not repeat it.
    expect(screen.queryByAltText('a red fox in snow')).toBeNull();
  });

  it('shows a call that waits for approval in full', () => {
    const pending = { requestId: 't1', response: undefined, isPending: true } as ToolRenderState;
    render(
      <CompactMessage
        sessionId="session"
        message={assistant([call('t1', 'developer__shell', { command: 'rm -rf build' })])}
        toolStates={[pending]}
        toolNotifications={[undefined]}
        toolConfirmationShownInline={false}
        append={vi.fn()}
        isStreaming={true}
      />,
      { wrapper: IntlTestWrapper }
    );

    expect(screen.getByText('full card t1')).toBeInTheDocument();
    expect(screen.queryByText('Ran a command')).toBeNull();
  });

  it("draws a recipe's structured result as a plain line, with no card to open", () => {
    render(
      <CompactMessage
        sessionId="session"
        message={assistant([call('f1', 'recipe__final_output', { answer: 'done' })])}
        toolStates={[state('f1', false)]}
        toolNotifications={[undefined]}
        toolConfirmationShownInline={false}
        append={vi.fn()}
        isStreaming={false}
      />,
      { wrapper: IntlTestWrapper }
    );

    expect(screen.getByText('Returned structured result')).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('shows only the failed calls when asked', async () => {
    renderSteps(true);
    await act(async () => {});

    expect(screen.getByText('Ran a command')).toBeInTheDocument();
    expect(screen.queryByText('Read a file')).toBeNull();
    expect(screen.queryByText('Thinking')).toBeNull();
    expect(screen.queryByText('Let me check the build.')).toBeNull();
  });
});

describe('GooseMessage in a turn', () => {
  it('leaves its thinking to the work section when told to', async () => {
    render(
      <GooseMessage
        sessionId="session"
        message={assistant([
          { type: 'thinking', thinking: 'Working it out', signature: '' },
          { type: 'text', text: 'Here is the answer.' },
        ])}
        hideTimestamp={false}
        toolStates={[]}
        toolNotifications={[]}
        toolConfirmationShownInline={false}
        append={vi.fn()}
        isStreaming={false}
        hideThinking
      />,
      { wrapper: IntlTestWrapper }
    );

    await act(async () => {});

    expect(screen.getByText('Here is the answer.')).toBeInTheDocument();
    expect(screen.queryByText('Thinking')).toBeNull();
  });
});
