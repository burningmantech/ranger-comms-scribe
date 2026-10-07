import { Env } from '../utils/sessionManager';
import { getUserNotificationSettings, getUser } from './userService';
import { sendReplyNotification } from '../utils/email';
import { AppNotification, NotificationType } from '../types';
import { putObject } from './cacheService';

// Links in emails point at the frontend (FRONTEND_URL), defaulting to production.
const frontendUrl = (env: Env): string => env.FRONTEND_URL || 'https://scrivenly.com';

/**
 * Send notification about a reply to the original content author
 */
export async function notifyAboutReply(
  contentAuthorId: string,
  replyAuthorName: string,
  contentType: 'post' | 'comment' | 'gallery',
  contentId: string,
  parentContentId: string, // postId for comments, mediaId for gallery comments
  contentSnippet: string,
  env: Env
): Promise<boolean> {
  try {
    // Check if the author has notification settings enabled for replies
    const authorSettings = await getUserNotificationSettings(contentAuthorId, env);
    if (!authorSettings.notifyOnReplies) {
      console.log(`Skipping reply notification for ${contentAuthorId} as notifications are disabled`);
      return false;
    }

    // Get the author's email
    const author = await getUser(contentAuthorId, env);
    if (!author || !author.email) {
      console.log(`Cannot send notification: User ${contentAuthorId} not found or has no email`);
      return false;
    }

    // Prepare the content URL using the FRONTEND_URL
    let contentUrl: string;
    switch (contentType) {
      case 'post':
        // For blog posts, link directly to the blog view which will show the post
        contentUrl = `${frontendUrl(env)}/blog?comment=${contentId}#${contentId}`;
        break;
      case 'comment':
        // For comments, link to the blog with the comment fragment identifier
        contentUrl = `${frontendUrl(env)}/blog?comment=${contentId}#${contentId}`;
        break;
      case 'gallery':
        // For gallery, link to the gallery view with the comment fragment identifier
        contentUrl = `${frontendUrl(env)}/gallery?comment=${contentId}#${contentId}`;
        break;
      default:
        contentUrl = `${frontendUrl(env)}`;
    }

    // Truncate content snippet if it's too long
    const truncatedSnippet = contentSnippet.length > 150 ? `${contentSnippet.substring(0, 147)}...` : contentSnippet;

    // Send the notification email
    await sendReplyNotification(
      author.email,
      replyAuthorName,
      contentType,
      truncatedSnippet,
      contentUrl,
      env
    );

    console.log(`Reply notification sent to ${author.email}`);
    return true;
  } catch (error) {
    console.error('Error sending reply notification:', error);
    return false;
  }
}

// =============================================================================
// In-App Notifications
// =============================================================================

interface CreateNotificationParams {
  /** The recipient's email, or their user id (looked up for the email). */
  userId: string;
  type: NotificationType;
  title: string;
  message: string;
  submissionId?: string;
  submissionTitle?: string;
  actorName?: string;
  /** Where the notification opens, when it isn't a request's review page. */
  link?: string;
}

/** Notifications are stored per person, under their lowercased email. */
export const NOTIFICATIONS_PREFIX = 'notifications/';

async function recipientEmail(userIdOrEmail: string, env: Env): Promise<string | null> {
  const value = (userIdOrEmail || '').trim();
  if (!value) return null;
  if (value.includes('@')) return value.toLowerCase();
  const user = await getUser(value, env);
  return user?.email ? user.email.toLowerCase() : null;
}

export async function createInAppNotification(
  params: CreateNotificationParams,
  env: Env
): Promise<AppNotification | null> {
  try {
    const email = await recipientEmail(params.userId, env);
    if (!email) {
      console.error(`Cannot create notification: no user found for ${params.userId}`);
      return null;
    }
    const notification: AppNotification = {
      id: crypto.randomUUID(),
      userId: email,
      type: params.type,
      title: params.title,
      message: params.message,
      submissionId: params.submissionId,
      submissionTitle: params.submissionTitle,
      actorName: params.actorName,
      ...(params.link ? { link: params.link } : {}),
      read: false,
      createdAt: new Date().toISOString(),
    };

    await putObject(`${NOTIFICATIONS_PREFIX}${email}/${notification.id}`, notification, env);
    return notification;
  } catch (error) {
    console.error('Error creating in-app notification:', error);
    return null;
  }
}

export async function notifyApprovalDecision(
  submissionId: string,
  submissionTitle: string,
  submittedBy: string,
  decision: 'approved' | 'rejected',
  actorName: string,
  env: Env
): Promise<void> {
  const type: NotificationType = decision === 'approved' ? 'approval_received' : 'rejection_received';
  const verb = decision === 'approved' ? 'approved' : 'rejected';

  await createInAppNotification({
    userId: submittedBy,
    type,
    title: `Submission ${verb}`,
    message: `${actorName} ${verb} "${submissionTitle}"`,
    submissionId,
    submissionTitle,
    actorName,
  }, env);
}
