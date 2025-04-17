import { Env } from '../utils/sessionManager';
import { getUserNotificationSettings, getUser, getAllUsers } from './userService';
import { getGroup } from './userService';
import { sendReplyNotification, sendGroupContentNotification } from '../utils/email';
import { User, Group } from '../types';

// Use the frontend URL for links in emails
const FRONTEND_URL = 'https://dancingcats.org';

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

    // Check if SES credentials are available
    if (!env.SESKey || !env.SESSecret) {
      console.error('Email service credentials not configured');
      return false;
    }

    // Prepare the content URL using the FRONTEND_URL
    let contentUrl: string;
    switch (contentType) {
      case 'post':
        // For blog posts, link directly to the blog view which will show the post
        contentUrl = `${FRONTEND_URL}/blog?comment=${contentId}#${contentId}`;
        break;
      case 'comment':
        // For comments, link to the blog with the comment fragment identifier
        contentUrl = `${FRONTEND_URL}/blog?comment=${contentId}#${contentId}`;
        break;
      case 'gallery':
        // For gallery, link to the gallery view with the comment fragment identifier
        contentUrl = `${FRONTEND_URL}/gallery?comment=${contentId}#${contentId}`;
        break;
      default:
        contentUrl = `${FRONTEND_URL}`;
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
      env.SESKey,
      env.SESSecret
    );

    console.log(`Reply notification sent to ${author.email}`);
    return true;
  } catch (error) {
    console.error('Error sending reply notification:', error);
    return false;
  }
}

/**
 * Send notifications to group members about new content
 */
export async function notifyGroupAboutNewContent(
  groupId: string,
  authorId: string,
  authorName: string,
  contentType: 'post' | 'gallery',
  contentId: string,
  contentTitle: string,
  contentSnippet: string,
  env: Env
): Promise<{ success: boolean; emailsSent: number }> {
  try {
    // Check if SES credentials are available
    if (!env.SESKey || !env.SESSecret) {
      console.error('Email service credentials not configured');
      return { success: false, emailsSent: 0 };
    }

    // Get the group
    const group = await getGroup(groupId, env);
    if (!group) {
      console.log(`Cannot send notification: Group ${groupId} not found`);
      return { success: false, emailsSent: 0 };
    }

    // Prepare the content URL
    const contentUrl = contentType === 'post' 
      ? `${FRONTEND_URL}/blog/post/${contentId}`
      : `${FRONTEND_URL}/gallery/item/${contentId}`;

    // Truncate content snippet if it's too long
    const truncatedSnippet = contentSnippet.length > 150 ? `${contentSnippet.substring(0, 147)}...` : contentSnippet;

    // Count emails successfully sent
    let emailsSent = 0;

    // For each group member, check their notification settings and send email if enabled
    for (const memberId of group.members) {
      // Skip the author of the content
      if (memberId === authorId) continue;

      // Check if the member has notification settings enabled for group content
      const memberSettings = await getUserNotificationSettings(memberId, env);
      if (!memberSettings.notifyOnGroupContent) {
        console.log(`Skipping group notification for ${memberId} as notifications are disabled`);
        continue;
      }

      // Get the member's email
      const member = await getUser(memberId, env);
      if (!member || !member.email) {
        console.log(`Cannot send notification: User ${memberId} not found or has no email`);
        continue;
      }

      try {
        // Send the notification email
        await sendGroupContentNotification(
          member.email,
          authorName,
          group.name,
          contentType,
          contentTitle,
          truncatedSnippet,
          contentUrl,
          env.SESKey,
          env.SESSecret
        );

        console.log(`Group content notification sent to ${member.email}`);
        emailsSent++;
      } catch (emailError) {
        console.error(`Error sending email to ${member.email}:`, emailError);
      }
    }

    return { success: true, emailsSent };
  } catch (error) {
    console.error('Error sending group content notifications:', error);
    return { success: false, emailsSent: 0 };
  }
}