import { Expo, ExpoPushMessage, ExpoPushTicket } from 'expo-server-sdk';
import User from '../models/User.js';

const expo = new Expo();

interface PushNotificationData {
  title: string;
  body: string;
  data?: Record<string, any>;
  badge?: number;
  sound?: 'default' | null;
}

async function removePushTokensForUser(userId: string, pushTokens: string[]): Promise<void> {
  if (!pushTokens.length) return;

  try {
    await User.updateOne(
      { _id: userId },
      { $pull: { pushTokens: { token: { $in: pushTokens } } } }
    );
  } catch (error) {
    console.error('Failed to remove invalid push tokens for user:', userId, error);
  }
}

async function removePushTokensEverywhere(pushTokens: string[]): Promise<void> {
  if (!pushTokens.length) return;

  try {
    await User.updateMany(
      { 'pushTokens.token': { $in: pushTokens } },
      { $pull: { pushTokens: { token: { $in: pushTokens } } } }
    );
  } catch (error) {
    console.error('Failed to remove invalid push tokens globally:', error);
  }
}

async function handleTickets(
  tickets: ExpoPushTicket[],
  chunkTokens: string[],
  userId: string,
  receiptIdToToken: Record<string, string>
): Promise<void> {
  const deviceNotRegisteredTokens = new Set<string>();

  tickets.forEach((ticket, index) => {
    const token = chunkTokens[index];
    if (!token) return;

    if (ticket.status === 'ok') {
      if (ticket.id) {
        receiptIdToToken[ticket.id] = token;
      }
      return;
    }

    console.error(`Expo ticket error for user ${userId}:`, ticket.message, ticket.details);
    const ticketError = (ticket.details as { error?: string } | undefined)?.error;
    if (ticketError === 'DeviceNotRegistered') {
      deviceNotRegisteredTokens.add(token);
    }
  });

  if (deviceNotRegisteredTokens.size > 0) {
    await removePushTokensEverywhere(Array.from(deviceNotRegisteredTokens));
  }
}

async function handleReceipts(receiptIdToToken: Record<string, string>): Promise<void> {
  const receiptIds = Object.keys(receiptIdToToken);
  if (!receiptIds.length) return;

  const receiptIdChunks = expo.chunkPushNotificationReceiptIds(receiptIds);
  const deviceNotRegisteredTokens = new Set<string>();

  for (const receiptIdChunk of receiptIdChunks) {
    try {
      const receipts = await expo.getPushNotificationReceiptsAsync(receiptIdChunk);
      for (const receiptId of Object.keys(receipts)) {
        const receipt = receipts[receiptId];
        if (receipt.status !== 'error') continue;

        const token = receiptIdToToken[receiptId];
        console.error('Expo receipt error:', receipt.message, receipt.details);

        const receiptError = (receipt.details as { error?: string } | undefined)?.error;
        if (receiptError === 'DeviceNotRegistered' && token) {
          deviceNotRegisteredTokens.add(token);
        }
      }
    } catch (error) {
      console.error('Error fetching Expo push receipts:', error);
    }
  }

  if (deviceNotRegisteredTokens.size > 0) {
    await removePushTokensEverywhere(Array.from(deviceNotRegisteredTokens));
  }
}

export async function sendPushNotificationToUser(
  userId: string,
  notification: PushNotificationData
): Promise<void> {
  try {
    const user = await User.findById(userId).select('pushTokens');

    if (!user || !user.pushTokens || user.pushTokens.length === 0) {
      return;
    }

    const messages: ExpoPushMessage[] = [];
    const tokensForMessages: string[] = [];
    const invalidTokens: string[] = [];
    const seenTokens = new Set<string>();

    for (const tokenData of user.pushTokens) {
      const pushToken = String(tokenData?.token || '').trim();
      if (!pushToken || seenTokens.has(pushToken)) continue;

      seenTokens.add(pushToken);
      if (!Expo.isExpoPushToken(pushToken)) {
        invalidTokens.push(pushToken);
        continue;
      }

      messages.push({
        to: pushToken,
        title: notification.title,
        body: notification.body,
        data: notification.data || {},
        badge: notification.badge,
        sound: notification.sound || 'default',
        priority: 'high',
        channelId:
          notification.data?.type === 'chat' || notification.data?.type === 'message'
            ? 'messages'
            : notification.data?.type?.startsWith('order_')
              ? 'orders'
              : 'default',
      });
      tokensForMessages.push(pushToken);
    }

    if (invalidTokens.length > 0) {
      await removePushTokensForUser(userId, invalidTokens);
    }

    if (messages.length === 0) {
      return;
    }

    const chunks = expo.chunkPushNotifications(messages);
    const receiptIdToToken: Record<string, string> = {};
    let tokenCursor = 0;

    for (const chunk of chunks) {
      const chunkTokens = tokensForMessages.slice(tokenCursor, tokenCursor + chunk.length);
      tokenCursor += chunk.length;

      try {
        const ticketChunk = await expo.sendPushNotificationsAsync(chunk);
        await handleTickets(ticketChunk, chunkTokens, userId, receiptIdToToken);
      } catch (error) {
        console.error('Error sending Expo notification chunk:', error);
      }
    }

    await handleReceipts(receiptIdToToken);
  } catch (error) {
    console.error('Error in sendPushNotificationToUser:', error);
  }
}

export async function sendPushNotificationToUsers(
  userIds: string[],
  notification: PushNotificationData
): Promise<void> {
  const sendPromises = userIds.map((userId) => sendPushNotificationToUser(userId, notification));
  await Promise.allSettled(sendPromises);
}

export async function sendFollowNotification(
  followerId: string,
  followedUserId: string,
  followerName: string
): Promise<void> {
  await sendPushNotificationToUser(followedUserId, {
    title: 'New Follower',
    body: `${followerName} started following you`,
    data: {
      type: 'follow',
      followerId,
    },
  });
}

export async function sendLikeNotification(
  likerId: string,
  postOwnerId: string,
  likerName: string,
  postId: string,
  postTitle?: string
): Promise<void> {
  if (likerId === postOwnerId) return;

  await sendPushNotificationToUser(postOwnerId, {
    title: 'New Like',
    body: `${likerName} liked your post${postTitle ? `: "${postTitle}"` : ''}`,
    data: {
      type: 'like',
      postId,
      likerId,
    },
  });
}

export async function sendCommentNotification(
  commenterId: string,
  postOwnerId: string,
  commenterName: string,
  postId: string,
  commentText: string
): Promise<void> {
  if (commenterId === postOwnerId) return;

  const truncatedComment = commentText.length > 50
    ? `${commentText.substring(0, 47)}...`
    : commentText;

  await sendPushNotificationToUser(postOwnerId, {
    title: 'New Comment',
    body: `${commenterName}: ${truncatedComment}`,
    data: {
      type: 'comment',
      postId,
      commenterId,
    },
  });
}

export async function sendOrderNotification(
  recipientId: string,
  orderId: string,
  title: string,
  body: string,
  type: 'order_placed' | 'order_confirmed' | 'order_shipped' | 'order_delivered' | 'order_cancelled'
): Promise<void> {
  await sendPushNotificationToUser(recipientId, {
    title,
    body,
    data: {
      type,
      orderId,
    },
  });
}

export async function sendChatNotification(
  senderId: string,
  recipientId: string,
  senderName: string,
  messageText: string,
  chatId: string
): Promise<void> {
  if (senderId === recipientId) return;

  const truncatedMessage = messageText.length > 60
    ? `${messageText.substring(0, 57)}...`
    : messageText;

  await sendPushNotificationToUser(recipientId, {
    title: senderName,
    body: truncatedMessage,
    data: {
      type: 'chat',
      chatId,
      senderId,
    },
  });
}

export default {
  sendPushNotificationToUser,
  sendPushNotificationToUsers,
  sendFollowNotification,
  sendLikeNotification,
  sendCommentNotification,
  sendOrderNotification,
  sendChatNotification,
};
