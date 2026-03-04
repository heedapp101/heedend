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
 * Create a COMMENT LIKE notification (when someone likes your comment)
 */
export const notifyCommentLike = async (
  recipientId: string,
  senderId: string,
  senderName: string,
  postId: string,
  commentId: string,
  commentText: string
) => {
  const truncatedComment = commentText.length > 30 
    ? commentText.substring(0, 30) + "..." 
    : commentText;
    
  // Create in-app notification
  const notification = await createNotification({
    recipientId,
    senderId,
    type: "comment_like",
    title: "Comment Liked",
    message: `${senderName} liked your comment: "${truncatedComment}"`,
    postId,
    commentId,
  });

  return notification;
};

/**
 * Create a COMMENT REPLY notification (when someone replies to your comment)
 */
export const notifyCommentReply = async (
  recipientId: string,
  senderId: string,
  senderName: string,
  postId: string,
  commentId: string,
  replyText: string
) => {
  const truncatedReply = replyText.length > 50 
    ? replyText.substring(0, 50) + "..." 
    : replyText;
    
  // Create in-app notification
  const notification = await createNotification({
    recipientId,
    senderId,
    type: "comment_reply",
    title: "Reply to Your Comment",
    message: `${senderName} replied: "${truncatedReply}"`,
    postId,
    commentId,
  });

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
  isBuyer: boolean = true,
  options?: {
    itemName?: string;
    businessName?: string;
  }
) => {
  const itemName = String(options?.itemName || "").trim();
  const businessName = String(options?.businessName || "").trim();
  const orderRef = `Order #${orderNumber}`;
  const orderWithItem = itemName ? `"${itemName}" (${orderRef})` : orderRef;
  const buyerOrderLabel = businessName ? `${orderWithItem} from ${businessName}` : orderWithItem;

  const statusMessages: Record<string, { title: string; message: string }> = {
    pending: {
      title: "Order Placed",
      message: isBuyer 
        ? `Your order ${buyerOrderLabel} has been placed successfully`
        : `New order ${orderWithItem} received`,
    },
    confirmed: {
      title: "Order Confirmed",
      message: isBuyer
        ? `Your order ${buyerOrderLabel} has been confirmed by the seller`
        : `Order ${orderWithItem} has been confirmed`,
    },
    processing: {
      title: "Order Processing",
      message: isBuyer
        ? `Your order ${buyerOrderLabel} is being prepared`
        : `Order ${orderWithItem} is now processing`,
    },
    shipped: {
      title: "Order Shipped",
      message: isBuyer
        ? `Your order ${buyerOrderLabel} has been shipped`
        : `Order ${orderWithItem} has been shipped`,
    },
    out_for_delivery: {
      title: "Out for Delivery",
      message: isBuyer
        ? `Your order ${buyerOrderLabel} is out for delivery`
        : `Order ${orderWithItem} is out for delivery`,
    },
    delivered: {
      title: "Order Delivered",
      message: isBuyer
        ? `Your order ${buyerOrderLabel} has been delivered`
        : `Order ${orderWithItem} has been delivered`,
    },
    cancelled: {
      title: "Order Cancelled",
      message: isBuyer
        ? `Your order ${buyerOrderLabel} has been cancelled`
        : `Order ${orderWithItem} has been cancelled`,
    },
    refund_requested: {
      title: "Refund Requested",
      message: `Refund requested for ${orderWithItem}`,
    },
    refunded: {
      title: "Refund Processed",
      message: `Refund processed for ${orderWithItem}`,
    },
  };

  const { title, message } = statusMessages[status] || {
    title: "Order Update",
    message: `${isBuyer ? "Your order" : "Order"} ${isBuyer ? buyerOrderLabel : orderWithItem} status updated to ${status}`,
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
    metadata: { orderNumber, status, itemName, businessName },
  });

  // Send push notification for order updates
  if (['order_placed', 'order_confirmed', 'order_shipped', 'order_delivered', 'order_cancelled'].includes(notifType)) {
    sendOrderNotification(recipientId, orderId, title, message, notifType as any, {
      itemName,
      businessName,
    }).catch(err => 
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
