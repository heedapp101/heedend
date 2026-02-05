import { Expo, ExpoPushMessage, ExpoPushTicket } from 'expo-server-sdk';
import User from '../models/User.js';

// Create a new Expo SDK client
const expo = new Expo();

interface PushNotificationData {
  title: string;
  body: string;
  data?: Record<string, any>;
  badge?: number;
  sound?: 'default' | null;
}

// Send push notification to a specific user
export async function sendPushNotificationToUser(
  userId: string, 
  notification: PushNotificationData
): Promise<void> {
  try {
    const user = await User.findById(userId).select('pushTokens');
    
    if (!user || !user.pushTokens || user.pushTokens.length === 0) {
      console.log(`No push tokens found for user ${userId}`);
      return;
    }

    // Build messages for all tokens
    const messages: ExpoPushMessage[] = [];
    
    for (const tokenData of user.pushTokens) {
      const pushToken = tokenData.token;
      
      // Validate token format
      if (!Expo.isExpoPushToken(pushToken)) {
        console.warn(`Invalid Expo push token: ${pushToken}`);
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
        // Android-specific: specify channel ID for proper notification handling
        channelId: notification.data?.type === 'chat' || notification.data?.type === 'message' 
          ? 'messages' 
          : notification.data?.type?.startsWith('order_') 
            ? 'orders' 
            : 'default',
        // Required for background notifications on Android
        _displayInForeground: true,
      });
    }

    if (messages.length === 0) {
      console.log('No valid push tokens to send notifications to');
      return;
    }

    // Chunk messages for batch sending
    const chunks = expo.chunkPushNotifications(messages);
    const tickets: ExpoPushTicket[] = [];

    for (const chunk of chunks) {
      try {
        const ticketChunk = await expo.sendPushNotificationsAsync(chunk);
        tickets.push(...ticketChunk);
      } catch (error) {
        console.error('Error sending push notification chunk:', error);
      }
    }

    // Handle tickets (optional: store for later receipt checking)
    handleTickets(tickets, userId);
    
  } catch (error) {
    console.error('Error in sendPushNotificationToUser:', error);
  }
}

// Send push notification to multiple users
export async function sendPushNotificationToUsers(
  userIds: string[], 
  notification: PushNotificationData
): Promise<void> {
  const sendPromises = userIds.map(userId => 
    sendPushNotificationToUser(userId, notification)
  );
  
  await Promise.allSettled(sendPromises);
}

// Handle notification tickets (check for errors)
function handleTickets(tickets: ExpoPushTicket[], userId: string): void {
  tickets.forEach((ticket, index) => {
    if (ticket.status === 'error') {
      console.error(
        `Error sending notification to user ${userId}:`,
        ticket.message,
        ticket.details
      );
      
      // Handle specific error types
      if (ticket.details?.error === 'DeviceNotRegistered') {
        // Token is invalid, should be removed from database
        console.log(`Should remove invalid token for user ${userId}`);
        // TODO: Implement token cleanup
      }
    }
  });
}

// ====== NOTIFICATION HELPER FUNCTIONS ======

// Send follow notification
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

// Send like notification
export async function sendLikeNotification(
  likerId: string,
  postOwnerId: string,
  likerName: string,
  postId: string,
  postTitle?: string
): Promise<void> {
  // Don't send notification to self
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

// Send comment notification
export async function sendCommentNotification(
  commenterId: string,
  postOwnerId: string,
  commenterName: string,
  postId: string,
  commentText: string
): Promise<void> {
  // Don't send notification to self
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

// Send order notification
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

// Send chat message notification
export async function sendChatNotification(
  senderId: string,
  recipientId: string,
  senderName: string,
  messageText: string,
  chatId: string
): Promise<void> {
  // Don't send notification to self
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
