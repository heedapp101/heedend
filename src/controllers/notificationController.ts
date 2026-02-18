import { Response } from "express";
import { AuthRequest } from "../middleware/authMiddleware.js";
import Notification from "../models/Notification.js";
import { markAsRead, markAllAsRead, getUnreadCount } from "../utils/notificationService.js";

/**
 * Get all notifications for the authenticated user
 * GET /api/notifications
 */
export const getNotifications = async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) return res.status(401).json({ message: "Unauthorized" });

    const { page = 1, limit = 20, unreadOnly = "false" } = req.query;
    const skip = (Number(page) - 1) * Number(limit);

    const query: any = { recipient: req.user._id };
    if (unreadOnly === "true") {
      query.read = false;
    }

    const [notifications, total, unreadCount] = await Promise.all([
      Notification.find(query)
        .populate("sender", "name username companyName userType profilePic")
        .populate("post", "title images")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(Number(limit))
        .lean(),
      Notification.countDocuments(query),
      getUnreadCount(req.user._id.toString()),
    ]);

    const normalizedNotifications = notifications.map((notification: any) => {
      const postData =
        notification?.post && typeof notification.post === "object"
          ? notification.post
          : null;
      const postTitle =
        typeof postData?.title === "string" ? postData.title.trim() : "";
      const postIdFromRelation = postData?._id ? String(postData._id) : "";
      const postIdFromMetadata = notification?.metadata?.postId
        ? String(notification.metadata.postId)
        : "";
      const fallbackPostId =
        typeof notification?.post === "string" ? notification.post : "";
      const postId = postIdFromRelation || postIdFromMetadata || fallbackPostId;

      let displayMessage =
        typeof notification?.message === "string" ? notification.message : "";
      if (postTitle) {
        if (postId && displayMessage.includes(postId)) {
          displayMessage = displayMessage.split(postId).join(postTitle);
        } else if (!displayMessage.toLowerCase().includes(postTitle.toLowerCase())) {
          displayMessage = `${displayMessage} (${postTitle})`;
        }
      }

      return {
        ...notification,
        displayMessage,
      };
    });

    res.json({
      notifications: normalizedNotifications,
      pagination: {
        page: Number(page),
        limit: Number(limit),
        total,
        pages: Math.ceil(total / Number(limit)),
      },
      unreadCount,
    });
  } catch (error) {
    console.error("Get Notifications Error:", error);
    res.status(500).json({ message: "Error fetching notifications" });
  }
};

/**
 * Get unread notification count
 * GET /api/notifications/unread-count
 */
export const getUnreadNotificationCount = async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) return res.status(401).json({ message: "Unauthorized" });

    const count = await getUnreadCount(req.user._id.toString());
    res.json({ count });
  } catch (error) {
    console.error("Get Unread Count Error:", error);
    res.status(500).json({ message: "Error fetching unread count" });
  }
};

/**
 * Mark a single notification as read
 * PATCH /api/notifications/:id/read
 */
export const markNotificationAsRead = async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) return res.status(401).json({ message: "Unauthorized" });

    const { id } = req.params;

    // Verify the notification belongs to the user
    const notification = await Notification.findOne({
      _id: id,
      recipient: req.user._id,
    });

    if (!notification) {
      return res.status(404).json({ message: "Notification not found" });
    }

    const updated = await markAsRead(id);
    res.json({ message: "Notification marked as read", notification: updated });
  } catch (error) {
    console.error("Mark Read Error:", error);
    res.status(500).json({ message: "Error marking notification as read" });
  }
};

/**
 * Mark all notifications as read
 * PATCH /api/notifications/read-all
 */
export const markAllNotificationsAsRead = async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) return res.status(401).json({ message: "Unauthorized" });

    await markAllAsRead(req.user._id.toString());
    res.json({ message: "All notifications marked as read" });
  } catch (error) {
    console.error("Mark All Read Error:", error);
    res.status(500).json({ message: "Error marking all notifications as read" });
  }
};

/**
 * Delete a notification
 * DELETE /api/notifications/:id
 */
export const deleteNotification = async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) return res.status(401).json({ message: "Unauthorized" });

    const { id } = req.params;

    const notification = await Notification.findOneAndDelete({
      _id: id,
      recipient: req.user._id,
    });

    if (!notification) {
      return res.status(404).json({ message: "Notification not found" });
    }

    res.json({ message: "Notification deleted" });
  } catch (error) {
    console.error("Delete Notification Error:", error);
    res.status(500).json({ message: "Error deleting notification" });
  }
};

/**
 * Clear all notifications
 * DELETE /api/notifications/clear-all
 */
export const clearAllNotifications = async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) return res.status(401).json({ message: "Unauthorized" });

    await Notification.deleteMany({ recipient: req.user._id });
    res.json({ message: "All notifications cleared" });
  } catch (error) {
    console.error("Clear All Error:", error);
    res.status(500).json({ message: "Error clearing notifications" });
  }
};
