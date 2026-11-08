import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../i18n/test-utils';
import type { Message, MessageContent, ToolResponseMessageContent } from '../types/message';
import type { ToolRenderState } from './messageRowContext';
import GooseMessage from './GooseMessage';

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

function renderCompact(onlyFailed = false) {
  const message: Message = {
    content: [
      { type: 'thinking', thinking: 'Working it out', signature: '' },
      { type: 'text', text: 'Let me check the build.' },
      call('t1', 'developer__shell', { command: 'cargo build' }),
      call('t2', 'developer__read', { path: 'src/main.rs' }),
    ],
    created: 1,
    metadata: { agentVisible: true, userVisible: true },
    role: 'assistant',
  };
  render(
    <GooseMessage
      sessionId="session"
      message={message}
      hideTimestamp={false}
      toolStates={[state('t1', true), state('t2', false)]}
      toolNotifications={[undefined, undefined]}
      toolConfirmationShownInline={false}
      append={vi.fn()}
      isStreaming={false}
      compact
      onlyFailed={onlyFailed}
    />,
    { wrapper: IntlTestWrapper }
  );
}

describe('GooseMessage', () => {
  it('renders operation details for a thinking-only message', () => {
    const message: Message = {
      content: [{ type: 'thinking', thinking: 'Working it out', signature: '' }],
      created: 1,
      metadata: {
        agentVisible: true,
        operationLogs: ['ops_auto_effort: thinking high'],
        userVisible: true,
      },
      role: 'assistant',
    };

    render(
      <GooseMessage
        sessionId="session"
        message={message}
        hideTimestamp={false}
        toolStates={[]}
        toolNotifications={[]}
        toolConfirmationShownInline={false}
        append={vi.fn()}
        isStreaming={false}
      />,
      { wrapper: IntlTestWrapper }
    );

    expect(screen.getByText('Thinking')).toBeInTheDocument();
    expect(screen.getByLabelText('ops_auto_effort: thinking high')).toBeInTheDocument();
  });

  it('draws every step on one line in compact mode, opened one at a time', () => {
    renderCompact();

    expect(screen.getByText('Thinking')).toBeInTheDocument();
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
  });

  it('shows only the failed calls when asked', () => {
    renderCompact(true);

    expect(screen.getByText('Ran a command')).toBeInTheDocument();
    expect(screen.queryByText('Read a file')).toBeNull();
    expect(screen.queryByText('Thinking')).toBeNull();
    expect(screen.queryByText('Let me check the build.')).toBeNull();
  });
});
