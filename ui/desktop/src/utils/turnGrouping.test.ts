import { describe, expect, it } from 'vitest';
import type { Message, MessageContent } from '../types/message';
import { deriveMessageRowContexts } from '../components/messageRowContext';
import {
  classifyToolCall,
  formatDuration,
  groupIntoTurns,
  isShortNote,
  type DisplayGroup,
  type Run,
  type ThinkingMode,
  type TurnBlock,
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

const LONG =
  'The build fails in three places. The first two are the same missing import. The third is a real type error in the parser that needs a closer look before I touch it.';

function group(
  messages: Message[],
  options: { thinking?: ThinkingMode; noticeBefore?: Set<number> } = {}
): DisplayGroup[] {
  return groupIntoTurns(
    messages.map((message, index) => ({ message, index })),
    {
      isUserMessage: (m) => m.role === 'user',
      isNotification: () => false,
      rowContexts: deriveMessageRowContexts(messages),
      thinking: options.thinking,
      noticeBefore: options.noticeBefore,
    }
  );
}

type Turn = Extract<DisplayGroup, { kind: 'turn' }>;
const turns = (groups: DisplayGroup[]) => groups.filter((g): g is Turn => g.kind === 'turn');
const runs = (turn: Turn) => turn.blocks.filter((b): b is Run => b.kind === 'run');

/** A turn's blocks in a line each, to read a layout at a glance. */
function outline(blocks: TurnBlock[]): string[] {
  return blocks.map((block) => {
    if (block.kind !== 'run') {
      return block.kind === 'note' || block.kind === 'thinking'
        ? `${block.kind}: ${block.text}`
        : block.kind;
    }
    const steps = block.steps.map((step) =>
      step.kind === 'tool' ? step.key : `${step.kind}(${step.text})`
    );
    return `run[${steps.join(', ')}]`;
  });
}

describe('groupIntoTurns', () => {
  it('keeps text in view, folds each run of calls into one row, and ends on the answer', () => {
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
    // The thinking before the first text is its own run; the answer's thinking ends the last one.
    expect(outline(turn.blocks)).toEqual([
      'run[thinking(plan)]',
      'note: Let me look.',
      'run[t1, t2, thinking(done)]',
    ]);
    expect(turn.final?.message.id).toBe('a3');
    expect(turn).toMatchObject({ firstIndex: 1, lastIndex: 5 });
    expect(turn.stats).toEqual({ startedAt: 10, failedToolCalls: 1 });
    expect(runs(turn)[1]).toMatchObject({ failed: 1, pending: false });
  });

  it('folds a short note into the run it leads to, and keeps longer text in view', () => {
    const [turn] = turns(
      group([
        msg('u1', 'user', [text('fix the build')]),
        msg('a1', 'assistant', [text('On it.'), call('t1')]),
        msg('r1', 'user', [result('t1')]),
        msg('a2', 'assistant', [text('Now the tests.'), call('t2', 'developer__read')]),
        msg('r2', 'user', [result('t2')]),
        msg('a3', 'assistant', [text(LONG), call('t3', 'developer__edit')]),
        msg('r3', 'user', [result('t3')]),
        msg('a4', 'assistant', [text('All green.')]),
      ])
    );

    expect(outline(turn.blocks)).toEqual([
      // Before the first call the model is answering the user: in view, however short.
      'note: On it.',
      'run[t1, note(Now the tests.), t2]',
      `note: ${LONG}`,
      'run[t3]',
    ]);
    expect(turn.final?.message.id).toBe('a4');
  });

  it('keeps a short note in view when no call follows it', () => {
    const [turn] = turns(
      group([
        msg('u1', 'user', [text('go')]),
        msg('a1', 'assistant', [call('t1')]),
        msg('r1', 'user', [result('t1')]),
        msg('a2', 'assistant', [text('Done with the scan.')]),
        msg('a3', 'assistant', [text('Summary: nothing to fix.')]),
      ])
    );
    expect(outline(turn.blocks)).toEqual(['run[t1]', 'note: Done with the scan.']);
    expect(turn.final?.message.id).toBe('a3');
  });

  it('puts thinking where the setting says: in the rows, in view, or nowhere', () => {
    const messages = [
      msg('u1', 'user', [text('check')]),
      msg('a1', 'assistant', [thinking('plan'), call('t1')], 10),
      msg('r1', 'user', [result('t1')]),
      msg('a2', 'assistant', [thinking('next'), call('t2')], 20),
      msg('r2', 'user', [result('t2')]),
      msg('a3', 'assistant', [thinking('done'), text('Answer.')], 30),
    ];

    const [folded] = turns(group(messages, { thinking: 'fold' }));
    expect(outline(folded.blocks)).toEqual([
      'run[thinking(plan), t1, thinking(next), t2, thinking(done)]',
    ]);

    // In view, thinking is text between the rows, so it ends the run before it.
    const [shown] = turns(group(messages, { thinking: 'show' }));
    expect(outline(shown.blocks)).toEqual([
      'thinking: plan',
      'run[t1]',
      'thinking: next',
      'run[t2]',
      'thinking: done',
    ]);

    const [hidden] = turns(group(messages, { thinking: 'hide' }));
    expect(outline(hidden.blocks)).toEqual(['run[t1, t2]']);
  });

  it('draws a reply whose only work was thinking as a row above it, or plainly when hidden', () => {
    const messages = [
      msg('u1', 'user', [text('hi')]),
      msg('a1', 'assistant', [thinking('hmm'), text('hello')]),
    ];

    const [turn] = turns(group(messages));
    expect(outline(turn.blocks)).toEqual(['run[thinking(hmm)]']);
    expect(turn.final?.message.id).toBe('a1');

    expect(group(messages, { thinking: 'hide' }).map((g) => g.kind)).toEqual(['single', 'single']);
  });

  it('leaves plain replies alone', () => {
    const groups = group([
      msg('u1', 'user', [text('hi')]),
      msg('a1', 'assistant', [text('hello')]),
      msg('a2', 'assistant', [text('and one more thing')]),
    ]);
    expect(groups.map((g) => g.kind)).toEqual(['single', 'single', 'single']);
  });

  it('has no answer while the turn is still on a call', () => {
    const [turn] = turns(
      group([
        msg('u1', 'user', [text('go')]),
        msg('a1', 'assistant', [call('t1', 'developer__shell', { command: 'docker ps' })]),
      ])
    );
    expect(turn.final).toBeNull();
    expect(runs(turn)[0].steps[0]).toMatchObject({
      kind: 'tool',
      tool: 'command',
      name: 'shell',
      target: 'docker ps',
      done: false,
      failed: false,
    });
  });

  it('keeps a generated picture with the run that made it', () => {
    const png = { type: 'image', data: 'AAAA', mimeType: 'image/png' };
    const [turn] = turns(
      group([
        msg('u1', 'user', [text('draw billy')]),
        msg('a1', 'assistant', [
          call('t1', 'developer__generate_image', { prompt: 'a 1920s cartoon mouse on a boat' }),
        ]),
        msg('r1', 'user', [
          {
            type: 'toolResponse',
            id: 't1',
            toolResult: { status: 'success', value: { content: [png], isError: false } },
          } as MessageContent,
        ]),
        msg('a2', 'assistant', [text('Billy is ready.')], 5),
      ])
    );
    expect(runs(turn)[0].images).toEqual([
      { data: 'AAAA', mimeType: 'image/png', alt: 'a 1920s cartoon mouse on a boat' },
    ]);
  });

  it('keeps what was written with a call in view while the call waits for approval', () => {
    const waiting = [
      msg('u1', 'user', [text('clean up')]),
      msg('a1', 'assistant', [call('t1', 'developer__tree')]),
      msg('r1', 'user', [result('t1')]),
      msg('a2', 'assistant', [text('Removing the folder now.'), call('t2')]),
      msg('c1', 'assistant', [
        {
          type: 'toolConfirmationRequest',
          id: 't2',
          toolName: 'developer__shell',
          arguments: {},
        } as MessageContent,
      ]),
    ];
    const [turn] = turns(group(waiting));
    expect(outline(turn.blocks)).toEqual(['run[t1]', 'note: Removing the folder now.', 'run[t2]']);
    expect(turn.final).toBeNull();
    expect(runs(turn)[0]).toMatchObject({ pending: false });
    expect(runs(turn)[1]).toMatchObject({ pending: true });
    expect(runs(turn)[1].steps[0]).toMatchObject({ kind: 'tool', pending: true, done: false });

    // Once it has run it is a call like any other, and the note folds in with it.
    const [after] = turns(group([...waiting, msg('r2', 'user', [result('t2')])]));
    expect(outline(after.blocks)).toEqual(['run[t1, note(Removing the folder now.), t2]']);
    expect(runs(after)[0]).toMatchObject({ pending: false });
  });

  it('leaves a note in view when the run it would fold into gets no call', () => {
    const [turn] = turns(
      group(
        [
          msg('u1', 'user', [text('go')]),
          msg('a1', 'assistant', [call('t1')]),
          msg('r1', 'user', [result('t1')]),
          // Thinking in view ends the run before the note, long text ends it after.
          msg('a2', 'assistant', [thinking('hm'), text('Now the tests.')]),
          msg('a3', 'assistant', [text(LONG), call('t2')]),
          msg('r2', 'user', [result('t2')]),
          msg('a4', 'assistant', [text('Done.')]),
        ],
        { thinking: 'show' }
      )
    );
    expect(outline(turn.blocks)).toEqual([
      'run[t1]',
      'thinking: hm',
      'note: Now the tests.',
      `note: ${LONG}`,
      'run[t2]',
    ]);
  });

  it('puts a notice before the message it belongs to, ending the run before it', () => {
    const [turn] = turns(
      group(
        [
          msg('u1', 'user', [text('go')]),
          msg('a1', 'assistant', [call('t1')]),
          msg('r1', 'user', [result('t1')]),
          msg('a2', 'assistant', [call('t2')]),
          msg('r2', 'user', [result('t2')]),
          msg('a3', 'assistant', [text('done')]),
        ],
        { noticeBefore: new Set([3]) }
      )
    );
    expect(outline(turn.blocks)).toEqual(['run[t1]', 'notice', 'run[t2]']);
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

  it('knows a run by its first step, so the row keeps its place while the run grows', () => {
    const before = [
      msg('u1', 'user', [text('go')]),
      msg('a1', 'assistant', [thinking('plan'), text('Starting.'), call('t1')]),
    ];
    const after = [
      ...before,
      msg('r1', 'user', [result('t1')]),
      msg('a2', 'assistant', [text('Next file.'), call('t2')]),
    ];
    const keys = (messages: Message[]) => runs(turns(group(messages))[0]).map((run) => run.key);
    expect(keys(before)).toEqual(['run-thinking-a1', 'run-t1']);
    expect(keys(after)).toEqual(['run-thinking-a1', 'run-t1']);
  });
});

describe('isShortNote', () => {
  it('takes a sentence or two', () => {
    expect(isShortNote('Now the tests.')).toBe(true);
    expect(isShortNote('The build passes. Moving on to the lint errors.')).toBe(true);
    expect(isShortNote('Let me check `src/main.rs` first')).toBe(true);
  });

  it('leaves anything with more to read in view', () => {
    expect(isShortNote(LONG)).toBe(false);
    expect(isShortNote('One. Two. Three.')).toBe(false);
    expect(isShortNote('First paragraph.\n\nSecond paragraph.')).toBe(false);
    expect(isShortNote('Plan:\n- read the file\n- fix it')).toBe(false);
    expect(isShortNote('Run this:\n```\ncargo build\n```')).toBe(false);
    expect(isShortNote('')).toBe(false);
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
  });

  it('splits the text editor by its sub-command', () => {
    expect(kind('developer__text_editor', { command: 'view' })).toBe('read');
    expect(kind('developer__text_editor', { command: 'str_replace' })).toBe('write');
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
