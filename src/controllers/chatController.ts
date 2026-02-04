import { Request, Response } from "express";
import { Chat, IChat, IMessage } from "../models/Chat.js";
import User from "../models/User.js";
import { Types } from "mongoose";
import { AuthRequest } from "../middleware/authMiddleware.js";

// --- Default Questions for Product Inquiries ---
export const DEFAULT_PRODUCT_QUESTIONS = [
  "Is this still available?",
  "What is the best price?",
  "Can you ship to my location?",
  "Is the condition new?",
  "Do you accept returns?",
  "Can I see more pictures?",
  "What's the delivery time?",
  "Is COD available?",
];

// --- Get or Create Chat ---
export const getOrCreateChat = async (req: AuthRequest, res: Response) => {
  try {
    const { recipientId, productContext } = req.body;
    const userId = req.user?._id;

    if (!userId || !recipientId) {
      return res.status(400).json({ message: "User ID and Recipient ID required" });
    }

    // Get both users to determine chat type
    const [currentUser, recipientUser] = await Promise.all([
      User.findById(userId).select("userType"),
      User.findById(recipientId).select("userType"),
    ]);

    if (!currentUser || !recipientUser) {
      return res.status(404).json({ message: "User not found" });
    }

    // Determine chat type based on user types
    let chatType: "general" | "business" | "admin" = "general";
    if (currentUser.userType === "admin" || recipientUser.userType === "admin") {
      chatType = "admin";
    } else if (currentUser.userType === "business" || recipientUser.userType === "business") {
      chatType = "business";
    }

    // Check if chat already exists between these users
    let chat = await Chat.findOne({
      participants: { $all: [userId, recipientId] },
      isActive: true,
    }).populate("participants", "username name profilePic userType isVerified");

    if (!chat) {
      // Create new chat
      chat = new Chat({
        participants: [userId, recipientId],
        chatType,
        productContext: productContext || undefined,
        messages: [],
        isActive: true,
      });
      await chat.save();

      // Populate after save
      chat = await Chat.findById(chat._id).populate(
        "participants",
        "username name profilePic userType isVerified"
      );
    } else if (productContext && !chat.productContext) {
      // Update product context if not set
      chat.productContext = productContext;
      await chat.save();
    }

    return res.status(200).json(chat);
  } catch (error) {
    console.error("Error in getOrCreateChat:", error);
    return res.status(500).json({ message: "Server error" });
  }
};

// --- Get All Chats for User ---
export const getUserChats = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?._id;
    const { type } = req.query; // "business", "general", "admin", or undefined for all

    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const query: any = {
      participants: userId,
      isActive: true,
    };

    if (type && ["general", "business", "admin"].includes(type as string)) {
      query.chatType = type;
    }

    const chats = await Chat.find(query)
      .populate("participants", "username name profilePic userType isVerified companyName")
      .populate("lastMessage.sender", "username name")
      .sort({ "lastMessage.createdAt": -1, updatedAt: -1 });

    // Add unread count and format response
    const formattedChats = chats.map((chat) => {
      const unreadCount = chat.messages.filter(
        (msg) => !msg.isRead && msg.sender.toString() !== userId?.toString()
      ).length;

      // Get the other participant
      const otherParticipant = chat.participants.find(
        (p: any) => p._id.toString() !== userId?.toString()
      );

      return {
        _id: chat._id,
        chatType: chat.chatType,
        participant: otherParticipant,
        productContext: chat.productContext,
        lastMessage: chat.lastMessage,
        unreadCount,
        updatedAt: chat.updatedAt,
      };
    });

    return res.status(200).json(formattedChats);
  } catch (error) {
    console.error("Error in getUserChats:", error);
    return res.status(500).json({ message: "Server error" });
  }
};

// --- Get Single Chat with Messages ---
export const getChatById = async (req: AuthRequest, res: Response) => {
  try {
    const { chatId } = req.params;
    const userId = req.user?._id;

    const chat = await Chat.findById(chatId)
      .populate("participants", "username name profilePic userType isVerified companyName phone")
      .populate("messages.sender", "username name profilePic");

    if (!chat) {
      return res.status(404).json({ message: "Chat not found" });
    }

    // Check if user is participant (admins can view any chat)
    const isParticipant = chat.participants.some(
      (p: any) => p._id.toString() === userId?.toString()
    );
    const isAdmin = req.user?.userType === "admin";

    if (!isParticipant && !isAdmin) {
      return res.status(403).json({ message: "Not authorized to view this chat" });
    }

    // Mark messages as read
    chat.messages.forEach((msg) => {
      if (msg.sender.toString() !== userId?.toString() && !msg.isRead) {
        msg.isRead = true;
      }
    });
    await chat.save();

    return res.status(200).json(chat);
  } catch (error) {
    console.error("Error in getChatById:", error);
    return res.status(500).json({ message: "Server error" });
  }
};

// --- Send Message ---
export const sendMessage = async (req: AuthRequest, res: Response) => {
  try {
    const { chatId } = req.params;
    const { content, messageType = "text", product, paymentRequest } = req.body;
    const userId = req.user?._id;

    if (!content && messageType === "text") {
      return res.status(400).json({ message: "Message content required" });
    }

    const chat = await Chat.findById(chatId);

    if (!chat) {
      return res.status(404).json({ message: "Chat not found" });
    }

    // Check if user is participant
    const isParticipant = chat.participants.some(
      (p) => p.toString() === userId?.toString()
    );

    if (!isParticipant) {
      return res.status(403).json({ message: "Not authorized" });
    }

    // Create message
    const newMessage: IMessage = {
      sender: new Types.ObjectId(userId),
      content,
      messageType,
      product: messageType === "product" ? product : undefined,
      paymentRequest: messageType === "payment-request" ? paymentRequest : undefined,
      isRead: false,
      createdAt: new Date(),
    };

    chat.messages.push(newMessage);
    chat.lastMessage = {
      content: messageType === "product" ? `📦 ${product?.title || "Product"}` : content,
      sender: new Types.ObjectId(userId),
      createdAt: new Date(),
    };

    await chat.save();

    // Get the saved message (last one in array)
    const savedMessage = chat.messages[chat.messages.length - 1];

    return res.status(201).json({
      message: savedMessage,
      chatId: chat._id,
    });
  } catch (error) {
    console.error("Error in sendMessage:", error);
    return res.status(500).json({ message: "Server error" });
  }
};

// --- Get Default Questions ---
export const getDefaultQuestions = async (req: Request, res: Response) => {
  return res.status(200).json(DEFAULT_PRODUCT_QUESTIONS);
};

// --- Delete Chat (Soft Delete) ---
export const deleteChat = async (req: AuthRequest, res: Response) => {
  try {
    const { chatId } = req.params;
    const userId = req.user?._id;

    const chat = await Chat.findById(chatId);

    if (!chat) {
      return res.status(404).json({ message: "Chat not found" });
    }

    const isParticipant = chat.participants.some(
      (p) => p.toString() === userId?.toString()
    );

    if (!isParticipant) {
      return res.status(403).json({ message: "Not authorized" });
    }

    chat.isActive = false;
    await chat.save();

    return res.status(200).json({ message: "Chat deleted" });
  } catch (error) {
    console.error("Error in deleteChat:", error);
    return res.status(500).json({ message: "Server error" });
  }
};

// --- Admin: Get All Chats (for support) ---
export const adminGetAllChats = async (req: AuthRequest, res: Response) => {
  try {
    if (req.user?.userType !== "admin") {
      return res.status(403).json({ message: "Admin access required" });
    }

    const { page = 1, limit = 20, search } = req.query;
    const skip = (Number(page) - 1) * Number(limit);

    let query: any = { chatType: "admin" };

    const chats = await Chat.find(query)
      .populate("participants", "username name profilePic userType")
      .sort({ "lastMessage.createdAt": -1 })
      .skip(skip)
      .limit(Number(limit));

    const total = await Chat.countDocuments(query);

    return res.status(200).json({
      chats,
      total,
      page: Number(page),
      pages: Math.ceil(total / Number(limit)),
    });
  } catch (error) {
    console.error("Error in adminGetAllChats:", error);
    return res.status(500).json({ message: "Server error" });
  }
};

// --- Admin: Create chat with user ---
export const adminInitiateChat = async (req: AuthRequest, res: Response) => {
  try {
    if (req.user?.userType !== "admin") {
      return res.status(403).json({ message: "Admin access required" });
    }

    const { userId } = req.body;
    const adminId = req.user._id;

    // Check if chat already exists
    let chat = await Chat.findOne({
      participants: { $all: [adminId, userId] },
      chatType: "admin",
      isActive: true,
    }).populate("participants", "username name profilePic userType");

    if (!chat) {
      chat = new Chat({
        participants: [adminId, userId],
        chatType: "admin",
        messages: [],
        isActive: true,
      });
      await chat.save();
      chat = await Chat.findById(chat._id).populate(
        "participants",
        "username name profilePic userType"
      );
    }

    return res.status(200).json(chat);
  } catch (error) {
    console.error("Error in adminInitiateChat:", error);
    return res.status(500).json({ message: "Server error" });
  }
};

// --- Mark Messages as Read ---
export const markMessagesRead = async (req: AuthRequest, res: Response) => {
  try {
    const { chatId } = req.params;
    const userId = req.user?._id;

    const chat = await Chat.findById(chatId);

    if (!chat) {
      return res.status(404).json({ message: "Chat not found" });
    }

    // Mark all messages from other users as read
    let updated = false;
    chat.messages.forEach((msg) => {
      if (msg.sender.toString() !== userId?.toString() && !msg.isRead) {
        msg.isRead = true;
        updated = true;
      }
    });

    if (updated) {
      await chat.save();
    }

    return res.status(200).json({ message: "Messages marked as read" });
  } catch (error) {
    console.error("Error in markMessagesRead:", error);
    return res.status(500).json({ message: "Server error" });
  }
};

// --- Get Unread Count ---
export const getUnreadCount = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?._id;

    const chats = await Chat.find({
      participants: userId,
      isActive: true,
    });

    let totalUnread = 0;
    let businessUnread = 0;
    let generalUnread = 0;
    let adminUnread = 0;

    chats.forEach((chat) => {
      const unread = chat.messages.filter(
        (msg) => !msg.isRead && msg.sender.toString() !== userId?.toString()
      ).length;

      totalUnread += unread;

      if (chat.chatType === "business") businessUnread += unread;
      else if (chat.chatType === "admin") adminUnread += unread;
      else generalUnread += unread;
    });

    return res.status(200).json({
      total: totalUnread,
      business: businessUnread,
      general: generalUnread,
      admin: adminUnread,
    });
  } catch (error) {
    console.error("Error in getUnreadCount:", error);
    return res.status(500).json({ message: "Server error" });
  }
};
