import { getTextAndImageContent, type Message } from '../types/message';
import { deriveMessageRowContexts, type MessageRowContext } from './messageRowContext';

/** Row contexts, with the conversation they were worked out from. */
export interface SettledRowContexts {
  /** The messages as they were when the contexts were last worked out. */
  messages: Message[];
  contexts: MessageRowContext[];
}

const shapes = new WeakMap<Message, string | null>();

/**
 * Everything deriveMessageRowContexts reads from a message, as a string: two messages of one
 * shape, in the same place, give the same contexts. Null for a message that carries something
 * a context is made of or points at (a tool result, an approval): for those, only the very same
 * message will do.
 */
function shapeOf(message: Message): string | null {
  let shape = shapes.get(message);
  if (shape === undefined) {
    shape = readShape(message);
    shapes.set(message, shape);
  }
  return shape;
}

function readShape(message: Message): string | null {
  const requestIds: string[] = [];
  for (const content of message.content) {
    if (content.type === 'toolRequest') {
      requestIds.push(content.id);
    } else if (content.type !== 'text' && content.type !== 'thinking') {
      return null;
    }
  }

  const inference = message.metadata.inference;
  return JSON.stringify([
    message.role,
    message.metadata.userVisible,
    inference?.requestedModel ?? null,
    inference?.resolvedModel ?? null,
    getTextAndImageContent(message).textContent.trim().length > 0,
    requestIds,
  ]);
}

function haveSameShapes(before: Message[], after: Message[]): boolean {
  if (before.length !== after.length) {
    return false;
  }

  // What changes is at the end.
  for (let index = after.length - 1; index >= 0; index--) {
    if (before[index] === after[index]) {
      continue;
    }
    const shape = shapeOf(after[index]);
    if (shape === null || shape !== shapeOf(before[index])) {
      return false;
    }
  }
  return true;
}

/**
 * The row contexts of a conversation, given the ones worked out last time.
 *
 * Working them out takes several passes over every message. While a reply streams in, only its
 * text and thinking grow, and nothing in a context depends on those: then the contexts from last
 * time are returned as they are. Without that, each chunk of a long session costs a pass over
 * the whole of it, and the window falls behind the model.
 */
export function settleRowContexts(
  previous: SettledRowContexts | undefined,
  messages: Message[]
): SettledRowContexts {
  if (previous && (previous.messages === messages || haveSameShapes(previous.messages, messages))) {
    return previous;
  }
  return { messages, contexts: deriveMessageRowContexts(messages) };
}
