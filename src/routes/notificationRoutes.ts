import { Router } from "express";
import { requireAuth } from "../middleware/authMiddleware.js";
import {
  getNotifications,
  getUnreadNotificationCount,
  markNotificationAsRead,
  markAllNotificationsAsRead,
  deleteNotification,
  clearAllNotifications,
} from "../controllers/notificationController.js";

const router = Router();

// All routes require authentication
router.use(requireAuth);

// Get all notifications
router.get("/", getNotifications);

// Get unread count
router.get("/unread-count", getUnreadNotificationCount);

// Mark single notification as read
router.patch("/:id/read", markNotificationAsRead);

// Mark all as read
router.patch("/read-all", markAllNotificationsAsRead);

// Clear all notifications
// Keep static route before dynamic :id route
router.delete("/clear-all", clearAllNotifications);

// Delete single notification
router.delete("/:id", deleteNotification);

export default router;
