import Notification, { NotificationType } from "../models/Notification.js";
import mongoose from "mongoose";
import { 
  sendFollowNotification, 
  sendLikeNotification, 
  sendCommentNotification,
  sendOrderNotification 
} from "./pushNotifications.js";

interface CreateNotificationParams {
  recipientId: string | mongoose.Types.ObjectId;
  senderId?: string | mongoose.Types.ObjectId;
  type: NotificationType;
  title: string;
  message: string;
  postId?: string | mongoose.Types.ObjectId;
  commentId?: string | mongoose.Types.ObjectId;
  orderId?: string | mongoose.Types.ObjectId;
  metadata?: Record<string, any>;
}

/**
 * Create a notification
 */
export const createNotification = async (params: CreateNotificationParams) => {
  try {
    // Don't create notification if sender is same as recipient (self-actions)
    if (params.senderId && params.recipientId.toString() === params.senderId.toString()) {
      return null;
    }

    const notification = await Notification.create({
      recipient: params.recipientId,
      sender: params.senderId,
      type: params.type,
      title: params.title,
      message: params.message,
      post: params.postId,
      comment: params.commentId,
      order: params.orderId,
      metadata: params.metadata,
    });

    return notification;
  } catch (error) {
    console.error("Error creating notification:", error);
    return null;
  }
};

/**
 * Create a LIKE notification
 */
export const notifyLike = async (
  recipientId: string,
  senderId: string,
  senderName: string,
  postId: string,
  postTitle: string
) => {
  // Create in-app notification
  const notification = await createNotification({
    recipientId,
    senderId,
    type: "like",
    title: "New Like",
    message: `${senderName} liked your post "${postTitle}"`,
    postId,
  });

  // Send push notification
  sendLikeNotification(senderId, recipientId, senderName, postId, postTitle).catch(err => 
    console.error('Push notification error (like):', err)
  );

  return notification;
};

/**
 * Create a COMMENT notification
 */
export const notifyComment = async (
  recipientId: string,
  senderId: string,
  senderName: string,
  postId: string,
  commentId: string,
  commentText: string
) => {
  const truncatedComment = commentText.length > 50 
    ? commentText.substring(0, 50) + "..." 
    : commentText;
    
  // Create in-app notification
  const notification = await createNotification({
    recipientId,
    senderId,
    type: "comment",
    title: "New Comment",
    message: `${senderName} commented: "${truncatedComment}"`,
    postId,
    commentId,
  });

  // Send push notification
  sendCommentNotification(senderId, recipientId, senderName, postId, commentText).catch(err => 
    console.error('Push notification error (comment):', err)
  );

  return notification;
};

/**
 * Create a FOLLOW notification
 */
export const notifyFollow = async (
  recipientId: string,
  senderId: string,
  senderName: string
) => {
  // Create in-app notification
  const notification = await createNotification({
    recipientId,
    senderId,
    type: "follow",
    title: "New Follower",
    message: `${senderName} started following you`,
  });

  // Send push notification
  sendFollowNotification(senderId, recipientId, senderName).catch(err => 
    console.error('Push notification error (follow):', err)
  );

  return notification;
};

/**
 * Create ORDER STATUS notification
 */
export const notifyOrderStatus = async (
  recipientId: string,
  orderId: string,
  orderNumber: string,
  status: string,
  isBuyer: boolean = true
) => {
  const statusMessages: Record<string, { title: string; message: string }> = {
    pending: {
      title: "Order Placed",
      message: isBuyer 
        ? `Your order #${orderNumber} has been placed successfully`
        : `New order #${orderNumber} received`,
    },
    confirmed: {
      title: "Order Confirmed",
      message: `Order #${orderNumber} has been confirmed by the seller`,
    },
    processing: {
      title: "Order Processing",
      message: `Order #${orderNumber} is being prepared`,
    },
    shipped: {
      title: "Order Shipped",
      message: `Order #${orderNumber} has been shipped`,
    },
    out_for_delivery: {
      title: "Out for Delivery",
      message: `Order #${orderNumber} is out for delivery`,
    },
    delivered: {
      title: "Order Delivered",
      message: `Order #${orderNumber} has been delivered`,
    },
    cancelled: {
      title: "Order Cancelled",
      message: `Order #${orderNumber} has been cancelled`,
    },
    refund_requested: {
      title: "Refund Requested",
      message: `Refund requested for order #${orderNumber}`,
    },
    refunded: {
      title: "Refund Processed",
      message: `Refund processed for order #${orderNumber}`,
    },
  };

  const { title, message } = statusMessages[status] || {
    title: "Order Update",
    message: `Order #${orderNumber} status updated to ${status}`,
  };

  const notifType = status === "pending" 
    ? "order_placed" 
    : status === "confirmed" 
      ? "order_confirmed"
      : status === "shipped" 
        ? "order_shipped"
        : status === "delivered"
          ? "order_delivered"
          : status === "cancelled"
            ? "order_cancelled"
            : "system";

  // Create in-app notification
  const notification = await createNotification({
    recipientId,
    type: notifType as NotificationType,
    title,
    message,
    orderId,
    metadata: { orderNumber, status },
  });

  // Send push notification for order updates
  if (['order_placed', 'order_confirmed', 'order_shipped', 'order_delivered', 'order_cancelled'].includes(notifType)) {
    sendOrderNotification(recipientId, orderId, title, message, notifType as any).catch(err => 
      console.error('Push notification error (order):', err)
    );
  }

  return notification;
};

/**
 * Mark notification as read
 */
export const markAsRead = async (notificationId: string) => {
  try {
    return await Notification.findByIdAndUpdate(
      notificationId,
      { read: true, readAt: new Date() },
      { new: true }
    );
  } catch (error) {
    console.error("Error marking notification as read:", error);
    return null;
  }
};

/**
 * Mark all notifications as read for a user
 */
export const markAllAsRead = async (userId: string) => {
  try {
    return await Notification.updateMany(
      { recipient: userId, read: false },
      { read: true, readAt: new Date() }
    );
  } catch (error) {
    console.error("Error marking all notifications as read:", error);
    return null;
  }
};

/**
 * Get unread count for a user
 */
export const getUnreadCount = async (userId: string) => {
  try {
    return await Notification.countDocuments({ recipient: userId, read: false });
  } catch (error) {
    console.error("Error getting unread count:", error);
    return 0;
  }
};
