import { describe, expect, it } from 'vitest';
import type { Message, MessageContent } from '../types/message';
import { deriveMessageRowContexts } from '../components/messageRowContext';
import {
  classifyToolCall,
  describeToolCall,
  formatDuration,
  groupIntoTurns,
  type DisplayGroup,
} from './turnGrouping';

const meta: Message['metadata'] = { agentVisible: true, userVisible: true };

function msg(id: string, role: Message['role'], content: MessageContent[], created = 1): Message {
  return { id, role, created, content, metadata: meta };
}
const text = (t: string): MessageContent => ({ type: 'text', text: t });
const thinking = (t: string): MessageContent =>
  ({ type: 'thinking', thinking: t, signature: '' }) as MessageContent;
const call = (
  id: string,
  name = 'developer__shell',
  args: Record<string, unknown> = {}
): MessageContent => ({
  type: 'toolRequest',
  id,
  toolCall: { status: 'success', value: { name, arguments: args } },
});
const result = (id: string, isError = false): MessageContent => ({
  type: 'toolResponse',
  id,
  toolResult: { status: 'success', value: { content: [], isError } },
});

function group(messages: Message[]): DisplayGroup[] {
  return groupIntoTurns(
    messages.map((message, index) => ({ message, index })),
    {
      isUserMessage: (m) => m.role === 'user',
      isNotification: () => false,
      rowContexts: deriveMessageRowContexts(messages),
      pendingConfirmationIds: new Set(),
    }
  );
}

function turns(groups: DisplayGroup[]) {
  return groups.filter((g): g is Extract<DisplayGroup, { kind: 'turn' }> => g.kind === 'turn');
}

describe('groupIntoTurns', () => {
  it('collapses tool calls and in-between text, keeps the last text as the answer', () => {
    const groups = group([
      msg('u1', 'user', [text('check the db')]),
      msg('a1', 'assistant', [thinking('plan'), text('Let me look.'), call('t1')], 10),
      msg('r1', 'user', [result('t1')]),
      msg('a2', 'assistant', [call('t2')], 20),
      msg('r2', 'user', [result('t2', true)]),
      msg('a3', 'assistant', [thinking('done'), text('Here is the answer.')], 45),
    ]);

    expect(groups[0]).toMatchObject({ kind: 'single', entry: { index: 0 } });
    const [turn] = turns(groups);
    expect(turn.work.map((e) => e.message.id)).toEqual(['a1', 'r1', 'a2', 'r2']);
    expect(turn.final?.message.id).toBe('a3');
    expect(turn.finalThinking).toBe('done');
    expect(turn.stats).toMatchObject({
      toolCalls: 2,
      failedToolCalls: 1,
      hasThinking: true,
      durationS: 35,
      needsAttention: false,
    });
  });

  it('has no answer while the turn is still on a tool call', () => {
    const [turn] = turns(
      group([
        msg('u1', 'user', [text('go')]),
        msg('a1', 'assistant', [call('t1', 'developer__shell', { command: 'docker ps' })]),
      ])
    );
    expect(turn.final).toBeNull();
    expect(turn.stats.activity).toBe('shell: docker ps');
  });

  it('leaves a plain reply alone', () => {
    const groups = group([
      msg('u1', 'user', [text('hi')]),
      msg('a1', 'assistant', [text('hello')]),
    ]);
    expect(groups.map((g) => g.kind)).toEqual(['single', 'single']);
  });

  it('puts the thinking of a reply without tools in a work section', () => {
    const [turn] = turns(
      group([
        msg('u1', 'user', [text('hi')]),
        msg('a1', 'assistant', [thinking('hmm'), text('hello')]),
      ])
    );
    expect(turn.work).toEqual([]);
    expect(turn.final?.message.id).toBe('a1');
    expect(turn.finalThinking).toBe('hmm');
  });

  it('starts a new turn at every real user message', () => {
    const groups = group([
      msg('u1', 'user', [text('one')]),
      msg('a1', 'assistant', [call('t1')]),
      msg('r1', 'user', [result('t1')]),
      msg('a2', 'assistant', [text('first answer')]),
      msg('u2', 'user', [text('two')]),
      msg('a3', 'assistant', [call('t2')]),
      msg('r2', 'user', [result('t2')]),
      msg('a4', 'assistant', [text('second answer')]),
    ]);
    expect(turns(groups).map((t) => t.final?.message.id)).toEqual(['a2', 'a4']);
  });

  it('flags a pending tool approval', () => {
    const messages = [
      msg('u1', 'user', [text('delete it')]),
      msg('a1', 'assistant', [call('t1')]),
      msg('c1', 'assistant', [
        {
          type: 'toolConfirmationRequest',
          id: 't1',
          toolName: 'developer__shell',
          arguments: {},
        } as MessageContent,
      ]),
    ];
    const [turn] = turns(
      groupIntoTurns(
        messages.map((message, index) => ({ message, index })),
        {
          isUserMessage: (m) => m.role === 'user',
          isNotification: () => false,
          rowContexts: deriveMessageRowContexts(messages),
          pendingConfirmationIds: new Set(['t1']),
        }
      )
    );
    expect(turn.stats.needsAttention).toBe(true);
    expect(turn.final).toBeNull();
  });
});

describe('classifyToolCall', () => {
  const kind = (name: string, args: Record<string, unknown> = {}) =>
    classifyToolCall({ status: 'success', value: { name, arguments: args } });

  it('reads tool names by their verbs', () => {
    expect(kind('developer__read')).toBe('read');
    expect(kind('developer__read_image')).toBe('read');
    expect(kind('developer__tree')).toBe('list');
    expect(kind('developer__shell')).toBe('command');
    expect(kind('developer__edit')).toBe('write');
    expect(kind('developer__write')).toBe('write');
    expect(kind('computercontroller__web_search')).toBe('search');
    expect(kind('fetch__fetch')).toBe('fetch');
    expect(kind('subagent__delegate')).toBe('agent');
    expect(kind('memory__remember_memory')).toBe('tool');
    expect(kind('developer__generate_image')).toBe('image');
    expect(kind('developer__read_image')).toBe('read');
  });

  it('splits the text editor by its sub-command', () => {
    expect(kind('developer__text_editor', { command: 'view' })).toBe('read');
    expect(kind('developer__text_editor', { command: 'str_replace' })).toBe('write');
  });
});

describe('describeToolCall', () => {
  it('uses the most telling argument and keeps it to one line', () => {
    expect(
      describeToolCall({
        status: 'success',
        value: { name: 'developer__tree', arguments: { path: 'C:\\x' } },
      })
    ).toBe('tree: C:\\x');
    expect(describeToolCall({ name: 'shell', arguments: { command: 'a\n  b' } })).toBe(
      'shell: a b'
    );
    expect(describeToolCall({ name: 'todo__write', arguments: {} })).toBe('write');
  });
});

describe('formatDuration', () => {
  it('reads naturally', () => {
    expect(formatDuration(9)).toBe('9s');
    expect(formatDuration(134)).toBe('2m 14s');
    expect(formatDuration(120)).toBe('2m');
    expect(formatDuration(3725)).toBe('1h 2m');
  });
});
