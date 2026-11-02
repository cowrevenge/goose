import { acpDeleteSession } from './sessions';
import { acpChatSessionActions } from './chatSessionStore';
import { cancelAcpPermissionRequestsForSession } from './permissionRequests';
import { cancelAcpElicitationRequestsForSession } from './elicitationRequests';
import { AppEvents } from '../constants/events';

/**
 * Deletes one session and drops everything the app still holds for it. The sessions view and the
 * sidebar both call this, so a delete does the same thing wherever it is started from. The
 * SESSION_DELETED event is what refreshes the lists and closes the chat when it is open.
 */
export async function deleteSessionWithCleanup(sessionId: string): Promise<void> {
  await acpDeleteSession(sessionId);
  window.dispatchEvent(new CustomEvent(AppEvents.SESSION_DELETED, { detail: { sessionId } }));
  cancelAcpPermissionRequestsForSession(sessionId);
  cancelAcpElicitationRequestsForSession(sessionId);
  acpChatSessionActions.deleteSnapshot(sessionId);
}
