import express from "express";
import {
  getOrCreateChat,
  getUserChats,
  getChatById,
  sendMessage,
  getDefaultQuestions,
  deleteChat,
  adminGetAllChats,
  adminInitiateChat,
  markMessagesRead,
  getUnreadCount,
} from "../controllers/chatController.js";
import { requireAuth } from "../middleware/authMiddleware.js";
import { adminMiddleware } from "../middleware/roleMiddleware.js";

const router = express.Router();

// --- Public ---
router.get("/default-questions", getDefaultQuestions);

// --- Protected Routes ---
router.use(requireAuth);

// Get all chats for user (with optional type filter)
router.get("/", getUserChats);

// Get unread message counts
router.get("/unread", getUnreadCount);

// Get or create chat with another user
router.post("/create", getOrCreateChat);

// Get single chat with messages
router.get("/:chatId", getChatById);

// Send message to chat
router.post("/:chatId/message", sendMessage);

// Mark messages as read
router.put("/:chatId/read", markMessagesRead);

// Delete (soft) a chat
router.delete("/:chatId", deleteChat);

// --- Admin Routes ---
router.get("/admin/all", adminMiddleware, adminGetAllChats);
router.post("/admin/initiate", adminMiddleware, adminInitiateChat);

export default router;
