import { Fragment, memo, useEffect, useMemo, useState } from 'react';
import { isEqual } from 'lodash';
import { defineMessages, useIntl } from '../i18n';
import GooseMessage from './GooseMessage';
import UserMessage from './UserMessage';
import { AlertTriangle } from 'lucide-react';
import Turn from './Turn';
import { useShowThinking } from '../hooks/useShowThinking';
import {
  SystemNotificationInline,
  getInlineSystemNotification,
} from './context_management/SystemNotificationInline';
import {
  CreditsExhaustedNotification,
  getCreditsExhaustedNotification,
} from './context_management/CreditsExhaustedNotification';
import {
  type ImageData,
  type Message,
  type NotificationEvent,
  type SystemNotificationContent,
} from '../types/message';
import {
  groupIntoTurns,
  isFailedResult,
  type DisplayedEntry,
  type ThinkingMode,
} from '../utils/turnGrouping';
import { getModelDisplayName } from './settings/models/predefinedModelsUtils';
import {
  deriveMessageRowContexts,
  type InferenceModel,
  inferenceModel,
  isModelChange,
  type MessageRowContext,
} from './messageRowContext';

const i18n = defineMessages({
  failedCalls: {
    id: 'messageList.failedCalls',
    defaultMessage: '{count, plural, one {# failed call} other {# failed calls}}',
  },
  showOnlyErrors: { id: 'messageList.showOnlyErrors', defaultMessage: 'Show only errors' },
  showEverything: { id: 'messageList.showEverything', defaultMessage: 'Show everything' },
  modelChanged: {
    id: 'messageList.modelChanged',
    defaultMessage: 'Model changed: {previousModel} → {currentModel}',
  },
  requestedModel: {
    id: 'messageList.requestedModel',
    defaultMessage: '{model} (requested)',
  },
  hiddenMessages: {
    id: 'messageList.hiddenMessages',
    defaultMessage: '{count, plural, one {# message hidden} other {# messages hidden}}',
  },
  showAllMessages: {
    id: 'messageList.showAllMessages',
    defaultMessage: 'Show all',
  },
});

const emptyToolCallNotifications = new Map<string, NotificationEvent[]>();
const emptyAppend = () => {};
const HEAD_MESSAGE_COUNT = 20;
const TAIL_MESSAGE_COUNT = 200;
const MESSAGE_DISPLAY_LIMIT = HEAD_MESSAGE_COUNT + TAIL_MESSAGE_COUNT;

function getSystemNotification(message: Message): SystemNotificationContent | undefined {
  return getCreditsExhaustedNotification(message) ?? getInlineSystemNotification(message);
}

function renderSystemNotification(notification: SystemNotificationContent) {
  switch (notification.notificationType) {
    case 'creditsExhausted':
      return <CreditsExhaustedNotification notification={notification} />;
    case 'inlineMessage':
      return <SystemNotificationInline notification={notification} />;
    default:
      return null;
  }
}

interface MessageRowProps {
  append: (value: string) => void;
  index: number;
  isStreaming: boolean;
  isUser: boolean;
  /** The answer of a turn: its thinking is with the turn's work, which sits right above it. */
  afterWork?: boolean;
  message: Message;
  modelChangeMessage: string | null;
  onMessageUpdate?: (
    messageId: string,
    newContent: string,
    editType: 'fork' | 'edit',
    retainedImages: ImageData[]
  ) => void;
  rowContext: MessageRowContext;
  sessionId: string;
  submitElicitationResponse?: (
    elicitationId: string,
    userData: Record<string, unknown>
  ) => Promise<boolean>;
  toolNotifications: readonly (NotificationEvent[] | undefined)[];
}

function MessageRowComponent({
  append,
  index,
  isStreaming,
  isUser,
  afterWork = false,
  message,
  modelChangeMessage,
  onMessageUpdate,
  rowContext,
  sessionId,
  submitElicitationResponse,
  toolNotifications,
}: MessageRowProps) {
  const notification = getSystemNotification(message);

  if (notification) {
    return (
      <div
        className={`relative ${index === 0 ? 'mt-0' : 'mt-4'} assistant`}
        data-testid="message-container"
      >
        {renderSystemNotification(notification)}
      </div>
    );
  }

  const hasOnlyToolResponses = message.content.every((content) => content.type === 'toolResponse');

  return (
    <Fragment>
      {modelChangeMessage && (
        <SystemNotificationInline
          notification={{
            msg: modelChangeMessage,
            notificationType: 'inlineMessage',
          }}
        />
      )}
      <div
        className={`relative ${index === 0 ? 'mt-0' : afterWork ? 'mt-2' : 'mt-4'} ${isUser ? 'user' : 'assistant'} ${rowContext.isInToolCallChain ? 'in-chain' : ''}`}
        data-testid="message-container"
      >
        {isUser ? (
          !hasOnlyToolResponses && (
            <UserMessage message={message} onMessageUpdate={onMessageUpdate} />
          )
        ) : (
          <GooseMessage
            sessionId={sessionId}
            message={message}
            hideTimestamp={rowContext.hideTimestamp}
            toolStates={rowContext.toolStates}
            toolNotifications={toolNotifications}
            toolConfirmationShownInline={rowContext.toolConfirmationShownInline}
            append={append}
            isStreaming={isStreaming}
            hideThinking={afterWork}
            submitElicitationResponse={submitElicitationResponse}
          />
        )}
      </div>
    </Fragment>
  );
}

const MessageRow = memo(MessageRowComponent, isEqual);

interface MessageListProps {
  messages: Message[];
  sessionId: string;
  toolCallNotifications?: Map<string, NotificationEvent[]>;
  append?: (value: string) => void;
  isUserMessage: (message: Message) => boolean;
  isStreamingMessage?: boolean;
  /** The turn has stopped to ask the user something (an approval, a question). */
  isWaitingForUser?: boolean;
  onMessageUpdate?: (
    messageId: string,
    newContent: string,
    editType: 'fork' | 'edit',
    retainedImages: ImageData[]
  ) => void;
  onRenderingComplete?: () => void;
  submitElicitationResponse?: (
    elicitationId: string,
    userData: Record<string, unknown>
  ) => Promise<boolean>;
}

export default function MessageList({
  messages,
  sessionId,
  toolCallNotifications = emptyToolCallNotifications,
  append = emptyAppend,
  isUserMessage,
  isStreamingMessage = false,
  isWaitingForUser = false,
  onMessageUpdate,
  onRenderingComplete,
  submitElicitationResponse,
}: MessageListProps) {
  const intl = useIntl();
  const [showAllMessages, setShowAllMessages] = useState(false);
  // Every failed tool call in the session, in place, so they can be tracked down one by one.
  const [errorsOnly, setErrorsOnly] = useState(false);
  // Where a turn's thinking goes follows the "Show Thinking" setting: folded into the rows
  // ("Collapsed", and until the setting has been read), in view ("Always"), or left out ("Never").
  const showThinking = useShowThinking();
  const thinking: ThinkingMode =
    showThinking === 'never' ? 'hide' : showThinking === 'always' ? 'show' : 'fold';
  const visibleMessages = useMemo(
    () =>
      messages.flatMap((message, index) =>
        message.metadata.userVisible ? [{ message, index }] : []
      ),
    [messages]
  );
  const hiddenMessageCount = showAllMessages
    ? 0
    : Math.max(0, visibleMessages.length - MESSAGE_DISPLAY_LIMIT);
  const hasHiddenMessages = hiddenMessageCount > 0;
  const displayedMessages = useMemo(() => {
    if (!hasHiddenMessages) {
      return visibleMessages;
    }

    const tailStart = visibleMessages.length - TAIL_MESSAGE_COUNT;
    return [...visibleMessages.slice(0, HEAD_MESSAGE_COUNT), ...visibleMessages.slice(tailStart)];
  }, [hasHiddenMessages, visibleMessages]);

  useEffect(() => {
    onRenderingComplete?.();
  }, [messages.length, onRenderingComplete, sessionId]);

  useEffect(() => {
    if (!hasHiddenMessages) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      const isMac = window.electron.platform === 'darwin';
      const isSearchShortcut =
        (isMac ? event.metaKey : event.ctrlKey) && !event.shiftKey && event.key === 'f';

      if (isSearchShortcut) {
        setShowAllMessages(true);
      }
    };
    const handleFindCommand = () => setShowAllMessages(true);

    window.addEventListener('keydown', handleKeyDown);
    window.electron.on('find-command', handleFindCommand);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.electron.off('find-command', handleFindCommand);
    };
  }, [hasHiddenMessages]);

  const rowContexts = useMemo(() => deriveMessageRowContexts(messages), [messages]);
  const modelLabel = (model: InferenceModel) =>
    model.confirmed
      ? getModelDisplayName(model.id)
      : intl.formatMessage(i18n.requestedModel, { model: getModelDisplayName(model.id) });

  const failedCallCount = useMemo(
    () =>
      rowContexts.reduce(
        (count, context) =>
          count +
          context.toolStates.filter(
            (state) => state.response && isFailedResult(state.response.toolResult)
          ).length,
        0
      ),
    [rowContexts]
  );
  const showingErrors = errorsOnly && failedCallCount > 0;

  // The model changed between the reply before this message and this one.
  const modelChangeFor = (index: number): string | null => {
    const currentModel = inferenceModel(messages[index]);
    const previousModel = rowContexts[index].previousModel;
    return currentModel && previousModel && isModelChange(previousModel, currentModel)
      ? intl.formatMessage(i18n.modelChanged, {
          previousModel: modelLabel(previousModel),
          currentModel: modelLabel(currentModel),
        })
      : null;
  };
  const modelChangeIndexes = useMemo(() => {
    const indexes = new Set<number>();
    messages.forEach((message, index) => {
      const currentModel = inferenceModel(message);
      const previousModel = rowContexts[index].previousModel;
      if (currentModel && previousModel && isModelChange(previousModel, currentModel)) {
        indexes.add(index);
      }
    });
    return indexes;
  }, [messages, rowContexts]);

  // One agent turn spans many messages (assistant messages and tool-result messages). They are
  // laid out as a turn: text in view, each run of tool calls as one row, the answer in full (see
  // utils/turnGrouping.ts). The errors view looks at the whole session, not only the messages the
  // long-chat limit shows.
  const groupedMessages = showingErrors ? visibleMessages : displayedMessages;
  const groups = useMemo(
    () =>
      groupIntoTurns(groupedMessages, {
        isUserMessage,
        isNotification: (message) => getSystemNotification(message) !== undefined,
        rowContexts,
        thinking,
        noticeBefore: modelChangeIndexes,
        breakBefore:
          !showingErrors && hiddenMessageCount > 0 ? new Set([HEAD_MESSAGE_COUNT]) : undefined,
      }),
    [
      groupedMessages,
      isUserMessage,
      rowContexts,
      thinking,
      modelChangeIndexes,
      hiddenMessageCount,
      showingErrors,
    ]
  );
  const lastMessageIndex = messages.length - 1;

  const renderRow = ({ message, index }: DisplayedEntry, { afterWork = false } = {}) => {
    const isUser = isUserMessage(message);
    const messageIdentifier = message.id ?? `msg-${index}-${message.created}`;
    const messageKey = getSystemNotification(message)
      ? `notification-${messageIdentifier}`
      : messageIdentifier;
    const rowContext = rowContexts[index];
    const modelChangeMessage = modelChangeFor(index);
    const toolNotifications = rowContext.toolStates.map((toolState) =>
      toolCallNotifications.get(toolState.requestId)
    );

    return (
      <MessageRow
        key={messageKey}
        append={append}
        index={index}
        isStreaming={
          isStreamingMessage &&
          !isUser &&
          index === lastMessageIndex &&
          message.role === 'assistant'
        }
        isUser={isUser}
        afterWork={afterWork}
        message={message}
        modelChangeMessage={modelChangeMessage}
        onMessageUpdate={onMessageUpdate}
        rowContext={rowContext}
        sessionId={sessionId}
        submitElicitationResponse={submitElicitationResponse}
        toolNotifications={toolNotifications}
      />
    );
  };

  const messageRows: React.ReactNode[] = [];
  let hiddenMarkerAdded = false;
  const addHiddenMarker = () => {
    hiddenMarkerAdded = true;
    messageRows.push(
      <div
        key="hidden-messages"
        className="my-6 flex items-center justify-center gap-2 text-xs text-text-secondary"
      >
        <span>{intl.formatMessage(i18n.hiddenMessages, { count: hiddenMessageCount })}</span>
        <button
          type="button"
          className="underline underline-offset-2 hover:text-text-primary"
          onClick={() => setShowAllMessages(true)}
        >
          {intl.formatMessage(i18n.showAllMessages)}
        </button>
      </div>
    );
  };
  const firstTailIndex =
    !showingErrors && hiddenMessageCount > 0
      ? displayedMessages[HEAD_MESSAGE_COUNT]?.index
      : undefined;

  if (failedCallCount > 0) {
    messageRows.push(
      <div
        key="errors-filter"
        className="sticky top-0 z-10 mb-2 flex items-center gap-2 text-xs text-text-secondary"
      >
        <button
          type="button"
          data-testid="errors-only-toggle"
          aria-pressed={showingErrors}
          onClick={() => setErrorsOnly((value) => !value)}
          className={`flex items-center gap-1 rounded border px-2 py-0.5 transition-colors ${
            showingErrors
              ? 'border-red-500 bg-red-500/10 text-red-500'
              : 'border-border-subtle bg-background-primary hover:text-text-primary'
          }`}
        >
          <AlertTriangle className="h-3 w-3 text-red-500" />
          {intl.formatMessage(i18n.failedCalls, { count: failedCallCount })}
          <span className="opacity-70">
            · {intl.formatMessage(showingErrors ? i18n.showEverything : i18n.showOnlyErrors)}
          </span>
        </button>
      </div>
    );
  }

  for (const group of groups) {
    // Errors view: only the turns that have a failed call, opened, showing just those calls.
    if (showingErrors && (group.kind === 'single' || group.stats.failedToolCalls === 0)) {
      continue;
    }

    const firstIndex = group.kind === 'single' ? group.entry.index : group.firstIndex;
    if (!hiddenMarkerAdded && firstTailIndex !== undefined && firstIndex >= firstTailIndex) {
      addHiddenMarker();
    }

    if (group.kind === 'single') {
      messageRows.push(renderRow(group.entry));
      continue;
    }

    messageRows.push(
      <div
        key={group.key}
        className={`relative ${group.firstIndex === 0 ? 'mt-0' : 'mt-4'} assistant`}
        data-testid="turn"
      >
        <Turn
          blocks={group.blocks}
          startedAt={group.stats.startedAt}
          working={
            isStreamingMessage &&
            !isWaitingForUser &&
            group.final === null &&
            group.lastIndex === lastMessageIndex
          }
          errorsOnly={showingErrors}
          rowContexts={rowContexts}
          toolCallNotifications={toolCallNotifications}
          sessionId={sessionId}
          append={append}
          noticeFor={modelChangeFor}
          submitElicitationResponse={submitElicitationResponse}
        />
      </div>
    );
    if (group.final && !showingErrors) {
      messageRows.push(renderRow(group.final, { afterWork: true }));
    }
  }

  return <>{messageRows}</>;
}
