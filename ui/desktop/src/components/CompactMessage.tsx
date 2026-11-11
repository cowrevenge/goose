import { memo } from 'react';
import ToolCallWithResponse from './ToolCallWithResponse';
import ToolCallConfirmation from './ToolCallConfirmation';
import ElicitationRequest from './ElicitationRequest';
import FinalOutputLine, { isFinalOutputToolRequest } from './FinalOutputLine';
import { CompactStepRow, CompactTextRow, ThinkingStepRow, useStepLabel } from './CompactStepRow';
import {
  getTextAndImageContent,
  getThinkingContent,
  getToolRequests,
  getToolConfirmationContent,
  getElicitationContent,
  type Message,
  type NotificationEvent,
} from '../types/message';
import {
  classifyToolCall,
  isFailedResult,
  toolCallName,
  toolCallTarget,
} from '../utils/turnGrouping';
import type { ToolRenderState } from './messageRowContext';

interface CompactMessageProps {
  sessionId: string;
  message: Message;
  toolStates: readonly ToolRenderState[];
  toolNotifications: readonly (NotificationEvent[] | undefined)[];
  toolConfirmationShownInline: boolean;
  append: (value: string) => void;
  isStreaming: boolean;
  /** Show only the tool calls that failed. */
  onlyFailed?: boolean;
  submitElicitationResponse?: (
    elicitationId: string,
    userData: Record<string, unknown>
  ) => Promise<boolean>;
}

/**
 * One assistant message of a turn's work, drawn as steps: its thinking, the text it wrote, and
 * each tool call on a line of its own, opened one at a time. GooseMessage draws the same message
 * in full; this is what a turn's work section lists (see MessageList).
 */
function CompactMessage({
  sessionId,
  message,
  toolStates,
  toolNotifications,
  toolConfirmationShownInline,
  append,
  isStreaming,
  onlyFailed = false,
  submitElicitationResponse,
}: CompactMessageProps) {
  const stepLabel = useStepLabel();

  const isOutputTokenLimitFallback =
    message.metadata.outputTokenLimitReached === true && message.metadata.fallbackContent === true;
  const { textContent, imagePaths } = getTextAndImageContent(message);
  const displayText = isOutputTokenLimitFallback ? '' : textContent;
  const hasImages = !isOutputTokenLimitFallback && imagePaths.length > 0;
  const thinkingContent = isOutputTokenLimitFallback ? null : getThinkingContent(message);
  const toolRequests = getToolRequests(message);
  const toolConfirmationContent = getToolConfirmationContent(message);
  const elicitationContent = getElicitationContent(message);
  const elicitationData =
    elicitationContent?.data.actionType === 'elicitation'
      ? (elicitationContent.data as typeof elicitationContent.data & {
          isSubmitted?: boolean;
          isCancelled?: boolean;
        })
      : undefined;
  const thinkingRunning =
    isStreaming && !displayText.trim() && !hasImages && toolRequests.length === 0;

  const renderToolCard = (toolRequest: (typeof toolRequests)[number], toolIndex: number) => {
    const toolState = toolStates[toolIndex];
    const isApprovalClicked = Boolean(
      toolState.confirmation && !toolState.isPending && toolState.response !== undefined
    );
    return (
      <ToolCallWithResponse
        sessionId={sessionId}
        isCancelledMessage={false}
        toolRequest={toolRequest}
        toolResponse={toolState.response}
        notifications={toolNotifications[toolIndex]}
        isStreamingMessage={isStreaming}
        isPendingApproval={toolState.isPending}
        append={append}
        confirmationContent={toolState.confirmation}
        isApprovalClicked={isApprovalClicked}
      />
    );
  };

  return (
    // Not "goose-message": that class gets the gap a full message leaves before the next user
    // message, which in here opened uneven holes between steps.
    <div className="flex w-[90%] flex-col min-w-0">
      {thinkingContent && !onlyFailed && (
        <ThinkingStepRow content={thinkingContent} running={thinkingRunning} />
      )}
      {displayText.trim() && !onlyFailed && <CompactTextRow text={displayText} />}
      {toolRequests.map((toolRequest, toolIndex) => {
        const toolState = toolStates[toolIndex];
        const failed = Boolean(toolState.response && isFailedResult(toolState.response.toolResult));
        if (onlyFailed && !failed) return null;
        // A recipe's structured result is a plain line here too: there is no card behind it.
        if (isFinalOutputToolRequest(toolRequest)) {
          return (
            <div className="py-0.5" key={toolRequest.id}>
              <FinalOutputLine toolResponse={toolState.response} isStreaming={isStreaming} />
            </div>
          );
        }
        // Waiting for the user: show it in full so the buttons are right there.
        if (toolState.isPending) {
          return (
            <div className="goose-message-tool my-2" key={toolRequest.id}>
              {renderToolCard(toolRequest, toolIndex)}
            </div>
          );
        }
        return (
          <div key={toolRequest.id}>
            <CompactStepRow
              label={stepLabel(
                classifyToolCall(toolRequest.toolCall),
                toolCallName(toolRequest.toolCall)
              )}
              detail={toolCallTarget(toolRequest.toolCall)}
              failed={failed}
              running={isStreaming && !toolState.response}
            >
              {renderToolCard(toolRequest, toolIndex)}
            </CompactStepRow>
          </div>
        );
      })}
      {!onlyFailed && toolConfirmationContent !== undefined && !toolConfirmationShownInline && (
        <ToolCallConfirmation
          sessionId={sessionId}
          isClicked={false}
          actionRequiredContent={toolConfirmationContent}
        />
      )}
      {!onlyFailed && elicitationContent !== undefined && submitElicitationResponse && (
        <ElicitationRequest
          isCancelledMessage={elicitationData?.isCancelled === true}
          isClicked={elicitationData?.isSubmitted === true}
          actionRequiredContent={elicitationContent}
          onSubmit={submitElicitationResponse}
        />
      )}
    </div>
  );
}

export default memo(CompactMessage);
