import { Request, Response } from "express";
import { Chat } from "../models/Chat.js";
import Message, { IMessage } from "../models/Message.js";
import User from "../models/User.js";
import { Types } from "mongoose";
import { AuthRequest } from "../middleware/authMiddleware.js";
import {
  emitChatNotificationToUsers,
  emitMessageToChat,
} from "../socket/socketHandler.js";

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

const toIdString = (value: any): string => {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof value?.toString === "function") return value.toString();
  return String(value);
};

const clampNumber = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));

const normalizeInquiryForSocket = (inquiry: any) => {
  if (!inquiry) return null;
  return {
    ...inquiry,
    _id: toIdString(inquiry._id),
    firstMessageId: inquiry.firstMessageId ? toIdString(inquiry.firstMessageId) : undefined,
    product: inquiry.product
      ? {
          ...inquiry.product,
          postId: toIdString(inquiry.product.postId),
        }
      : inquiry.product,
  };
};

const normalizeMessageForSocket = (message: any, senderId: string) => ({
  ...message,
  _id: toIdString(message?._id),
  sender: { _id: senderId },
  inquiryId: message?.inquiryId ? toIdString(message.inquiryId) : undefined,
  product: message?.product
    ? {
        ...message.product,
        postId: toIdString(message.product.postId),
      }
    : message?.product,
});

const emitRealtimeChatEvent = (
  chat: any,
  senderId: string,
  message: any,
  activeInquiry?: any
) => {
  const chatId = toIdString(chat?._id);
  if (!chatId) return;

  const payload = {
    chatId,
    message: normalizeMessageForSocket(message, senderId),
    activeInquiry: normalizeInquiryForSocket(activeInquiry) || null,
  };

  emitMessageToChat(chatId, payload);

  const participants = (chat?.participants || []).map((p: any) => toIdString(p));
  emitChatNotificationToUsers(participants, senderId, {
    chatId,
    message: payload.message,
    from: senderId,
  });
};

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
    }).populate("participants", "username name companyName profilePic userType isVerified");

    if (!chat) {
      // Create new chat
      chat = new Chat({
        participants: [userId, recipientId],
        chatType,
        productContext: productContext || undefined,
        isActive: true,
      });
      await chat.save();

      // Populate after save
      chat = await Chat.findById(chat._id).populate(
        "participants",
        "username name companyName profilePic userType isVerified"
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
    const page = clampNumber(parseInt(req.query.page as string) || 1, 1, 1000);
    const limit = clampNumber(parseInt(req.query.limit as string) || 20, 1, 100);
    const skip = (page - 1) * limit;

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

    const [chats, total] = await Promise.all([
      Chat.find(query)
      .populate("participants", "username name companyName profilePic userType isVerified")
      .populate("lastMessage.sender", "username name companyName userType")
      .sort({ "lastMessage.createdAt": -1, updatedAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
      Chat.countDocuments(query),
    ]);

    const chatIds = chats.map((chat) => chat._id);
    const unreadMap = new Map<string, number>();
    if (chatIds.length > 0) {
      const unreadCounts = await Message.aggregate([
        {
          $match: {
            chat: { $in: chatIds },
            isRead: false,
            sender: { $ne: userId },
          },
        },
        {
          $group: {
            _id: "$chat",
            count: { $sum: 1 },
          },
        },
      ]);
      unreadCounts.forEach((entry) => {
        unreadMap.set(String(entry._id), entry.count);
      });
    }

    // Add unread count and format response
    const formattedChats = chats.map((chat) => {
      const unreadCount = unreadMap.get(chat._id.toString()) || 0;

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

    return res.status(200).json({
      chats: formattedChats,
      total,
      page,
      pages: Math.ceil(total / limit),
    });
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
    const page = clampNumber(parseInt(req.query.page as string) || 1, 1, 1000);
    const limit = clampNumber(parseInt(req.query.limit as string) || 50, 1, 100);
    const skip = (page - 1) * limit;

    const chat = await Chat.findById(chatId)
      .populate("participants", "username name companyName profilePic userType isVerified phone");

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

    const messageExists = await Message.exists({ chat: chat._id });
    if (!messageExists) {
      try {
        const legacyChat = await Chat.findById(chatId).select("+messages");
        const legacyMessages = (legacyChat as any)?.messages || [];
        if (legacyMessages.length > 0) {
          const migrated = legacyMessages.map((msg: any) => ({
            _id: msg._id || new Types.ObjectId(),
            chat: legacyChat?._id,
            sender: msg.sender,
            content: msg.content,
            messageType: msg.messageType,
            product: msg.product,
            inquiryId: msg.inquiryId,
            replyTo: msg.replyTo,
            paymentRequest: msg.paymentRequest,
            orderUpdate: msg.orderUpdate,
            deliveryConfirmation: msg.deliveryConfirmation,
            isRead: msg.isRead ?? false,
            createdAt: msg.createdAt || new Date(),
            updatedAt: msg.updatedAt || msg.createdAt || new Date(),
          }));
          await Message.insertMany(migrated, { ordered: false });
          legacyChat!.messages = [];
          await legacyChat!.save();
        }
      } catch (migrationError) {
        console.warn("Legacy chat migration failed:", migrationError);
      }
    }

    const [messages, totalMessages] = await Promise.all([
      Message.find({ chat: chat._id })
        .select("-chat")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate("sender", "username name companyName userType profilePic")
        .lean(),
      Message.countDocuments({ chat: chat._id }),
    ]);

    await Message.updateMany(
      { chat: chat._id, sender: { $ne: userId }, isRead: false },
      { $set: { isRead: true } }
    );

    return res.status(200).json({
      ...chat.toObject(),
      messages: messages.reverse(),
      pagination: {
        page,
        limit,
        total: totalMessages,
        pages: Math.ceil(totalMessages / limit),
      },
    });
  } catch (error) {
    console.error("Error in getChatById:", error);
    return res.status(500).json({ message: "Server error" });
  }
};

// --- Send Message ---
export const sendMessage = async (req: AuthRequest, res: Response) => {
  try {
    const { chatId } = req.params;
    const { content, messageType = "text", product, paymentRequest, inquiryId, negotiate } = req.body;
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

    const normalizeProduct = (rawProduct: any) => {
      if (!rawProduct || !rawProduct.postId) return undefined;
      if (!Types.ObjectId.isValid(String(rawProduct.postId))) return undefined;
      return {
        postId: new Types.ObjectId(rawProduct.postId),
        title: rawProduct.title || "",
        price: Number(rawProduct.price || 0),
        image: rawProduct.image || "",
        selectedSize:
          typeof rawProduct.selectedSize === "string" && rawProduct.selectedSize.trim().length > 0
            ? rawProduct.selectedSize.trim()
            : undefined,
        sizeOptions: Array.isArray(rawProduct.sizeOptions)
          ? rawProduct.sizeOptions
              .map((size: any) => String(size || "").trim())
              .filter((size: string) => size.length > 0)
          : [],
      };
    };

    const isInquiryMessage = messageType === "inquiry";
    const shouldIncludeProduct = messageType === "product" || isInquiryMessage;
    const incomingSizeOptions = Array.isArray(product?.sizeOptions)
      ? product.sizeOptions
          .map((size: any) => String(size || "").trim())
          .filter((size: string) => size.length > 0)
      : [];
    const hasSelectedSize =
      typeof product?.selectedSize === "string" && product.selectedSize.trim().length > 0;
    const shouldPromptSelectSize = isInquiryMessage && incomingSizeOptions.length > 0 && !hasSelectedSize;
    const normalizedProduct = shouldIncludeProduct ? normalizeProduct(product) : undefined;

    if (shouldIncludeProduct && !normalizedProduct) {
      return res.status(400).json({ message: "Product information required" });
    }

    let finalInquiryId: Types.ObjectId | undefined;

    if (isInquiryMessage && normalizedProduct) {
      const newInquiry = {
        _id: new Types.ObjectId(),
        product: normalizedProduct,
        status: "active" as const,
        createdAt: new Date(),
        firstMessageId: undefined as Types.ObjectId | undefined,
      };
      chat.inquiries.push(newInquiry);
      chat.activeInquiryId = newInquiry._id;
      finalInquiryId = newInquiry._id;
    } else if (inquiryId && Types.ObjectId.isValid(String(inquiryId))) {
      finalInquiryId = new Types.ObjectId(inquiryId);
    } else if (chat.activeInquiryId) {
      finalInquiryId = chat.activeInquiryId as Types.ObjectId;
    }

    // Create message
    const senderMessageId = new Types.ObjectId();
    if (isInquiryMessage) {
      const latestInquiry = chat.inquiries.find(
        (inquiry) => inquiry._id?.toString() === finalInquiryId?.toString()
      );
      if (latestInquiry) {
        latestInquiry.firstMessageId = senderMessageId;
      }
    }

    const newMessage: IMessage = {
      _id: senderMessageId,
      chat: chat._id,
      sender: new Types.ObjectId(userId),
      content,
      messageType,
      product: shouldIncludeProduct ? normalizedProduct : undefined,
      inquiryId: finalInquiryId,
      paymentRequest: messageType === "payment-request" ? paymentRequest : undefined,
      isRead: false,
      createdAt: new Date(),
    } as IMessage;

    const savedMessageDoc = await Message.create(newMessage);
    chat.lastMessage = {
      content: messageType === "product"
        ? `Product: ${normalizedProduct?.title || "Product"}`
        : messageType === "inquiry"
          ? `Inquiry: ${normalizedProduct?.title || "Product"}`
          : messageType === "image"
            ? "Photo"
            : content,
      sender: new Types.ObjectId(userId),
      createdAt: new Date(),
    };

    await chat.save();
    const activeInquiry =
      chat.activeInquiryId
        ? chat.inquiries.find((i) => toIdString(i._id) === toIdString(chat.activeInquiryId))
        : null;
    emitRealtimeChatEvent(chat, toIdString(userId), savedMessageDoc.toObject(), activeInquiry);

    // Optional business auto-reply when buyer sends the first/manual message
    try {
      const recipientIds = chat.participants
        .map((p) => p.toString())
        .filter((id) => id !== userId?.toString());

      const businessRecipient = await User.findOne({
        _id: { $in: recipientIds },
        userType: "business",
      }).select("autoReplyEnabled autoReplyMessage");

      if (businessRecipient && req.user?.userType !== "business") {
        const autoReplyInquiryId = finalInquiryId || chat.activeInquiryId;

        // When user presses "Negotiate" button, always auto-reply
        if (negotiate) {
          const negotiateReplyText = "We'll reply you shortly.";
          const autoReplyMessage: IMessage = {
            chat: chat._id,
            sender: new Types.ObjectId(businessRecipient._id),
            content: negotiateReplyText,
            messageType: "text",
            inquiryId: autoReplyInquiryId,
            isRead: false,
            createdAt: new Date(),
          } as IMessage;
          const savedAutoReply = await Message.create(autoReplyMessage);
          chat.lastMessage = {
            content: negotiateReplyText,
            sender: new Types.ObjectId(businessRecipient._id),
            createdAt: new Date(),
          };
          await chat.save();
          emitRealtimeChatEvent(
            chat,
            businessRecipient._id.toString(),
            savedAutoReply.toObject(),
            activeInquiry
          );
        } else if (isInquiryMessage && normalizedProduct && autoReplyInquiryId) {
          const existingAutoProductReply = await Message.findOne({
            chat: chat._id,
            sender: businessRecipient._id,
            messageType: "product",
            inquiryId: autoReplyInquiryId,
          })
            .sort({ createdAt: -1 })
            .lean();

          if (!existingAutoProductReply) {
            if (shouldPromptSelectSize) {
              const sizePromptText = "Choose a size from the buttons below to continue.";
              const sizePromptMessage: IMessage = {
                chat: chat._id,
                sender: new Types.ObjectId(businessRecipient._id),
                content: sizePromptText,
                messageType: "text",
                inquiryId: autoReplyInquiryId,
                isRead: false,
                createdAt: new Date(),
              } as IMessage;

              const savedSizePrompt = await Message.create(sizePromptMessage);
              emitRealtimeChatEvent(
                chat,
                businessRecipient._id.toString(),
                savedSizePrompt.toObject(),
                activeInquiry
              );
            }

            const autoReplyCtaText = shouldPromptSelectSize
              ? "Choose size, then tap Buy Now or Negotiate below."
              : "Tap Buy Now or Negotiate below.";
            const autoReplyMessage: IMessage = {
              chat: chat._id,
              sender: new Types.ObjectId(businessRecipient._id),
              content: autoReplyCtaText,
              messageType: "product",
              product: normalizedProduct,
              inquiryId: autoReplyInquiryId,
              isRead: false,
              createdAt: new Date(),
            } as IMessage;

            const savedAutoReply = await Message.create(autoReplyMessage);
            chat.lastMessage = {
              content: `Product: ${normalizedProduct.title || "Product"}`,
              sender: new Types.ObjectId(businessRecipient._id),
              createdAt: new Date(),
            };
            await chat.save();
            emitRealtimeChatEvent(
              chat,
              businessRecipient._id.toString(),
              savedAutoReply.toObject(),
              activeInquiry
            );
          }
        } else {
          const autoReplyText =
            businessRecipient.autoReplyMessage?.trim() ||
            "Thanks for your message. We will reply soon.";

          const now = Date.now();
          const recentlySentSameReply = await Message.findOne({
            chat: chat._id,
            sender: businessRecipient._id,
            content: autoReplyText,
          })
            .sort({ createdAt: -1 })
            .lean();

          if (!recentlySentSameReply || now - new Date(recentlySentSameReply.createdAt).getTime() >= 90 * 1000) {
            const autoReplyMessage: IMessage = {
              chat: chat._id,
              sender: new Types.ObjectId(businessRecipient._id),
              content: autoReplyText,
              messageType: "text",
              inquiryId: finalInquiryId,
              isRead: false,
              createdAt: new Date(),
            } as IMessage;

            const savedAutoReply = await Message.create(autoReplyMessage);
            chat.lastMessage = {
              content: autoReplyText,
              sender: new Types.ObjectId(businessRecipient._id),
              createdAt: new Date(),
            };
            await chat.save();
            emitRealtimeChatEvent(
              chat,
              businessRecipient._id.toString(),
              savedAutoReply.toObject(),
              activeInquiry
            );
          }
        }
      }
    } catch (autoReplyError) {
      console.error("Auto-reply error:", autoReplyError);
    }

    // Return the sender message even if an auto-reply was appended after it.
    const savedMessage = savedMessageDoc.toObject();

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
  try {
    const recipientId = req.query.recipientId as string | undefined;
    if (!recipientId) {
      return res.status(200).json(DEFAULT_PRODUCT_QUESTIONS);
    }

    const recipient = await User.findById(recipientId).select("customQuickQuestion");
    const customQuestion = recipient?.customQuickQuestion?.trim();

    if (!customQuestion) {
      return res.status(200).json(DEFAULT_PRODUCT_QUESTIONS);
    }

    const merged = [customQuestion, ...DEFAULT_PRODUCT_QUESTIONS.filter(q => q !== customQuestion)];
    return res.status(200).json(merged);
  } catch (error) {
    console.error("Get default questions error:", error);
    return res.status(200).json(DEFAULT_PRODUCT_QUESTIONS);
  }
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
      .populate("participants", "username name companyName profilePic userType")
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
    }).populate("participants", "username name companyName profilePic userType");

    if (!chat) {
      chat = new Chat({
        participants: [adminId, userId],
        chatType: "admin",
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

    await Message.updateMany(
      { chat: chatId, sender: { $ne: userId }, isRead: false },
      { $set: { isRead: true } }
    );

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
    }).select("_id chatType");

    let totalUnread = 0;
    let businessUnread = 0;
    let generalUnread = 0;
    let adminUnread = 0;

    const chatIds = chats.map((chat) => chat._id);
    const unreadMap = new Map<string, number>();
    if (chatIds.length > 0) {
      const unreadCounts = await Message.aggregate([
        {
          $match: {
            chat: { $in: chatIds },
            isRead: false,
            sender: { $ne: userId },
          },
        },
        {
          $group: {
            _id: "$chat",
            count: { $sum: 1 },
          },
        },
      ]);
      unreadCounts.forEach((entry) => {
        unreadMap.set(String(entry._id), entry.count);
      });
    }

    chats.forEach((chat) => {
      const unread = unreadMap.get(chat._id.toString()) || 0;
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

// --- Send Offer Price (Business Users Only) ---
export const sendOfferPrice = async (req: AuthRequest, res: Response) => {
  try {
    const { chatId } = req.params;
    const { offerPrice, inquiryId, product } = req.body;
    const userId = req.user?._id;
    const userType = req.user?.userType;

    // Only business users can send offers
    if (userType !== "business") {
      return res.status(403).json({ message: "Only business users can send offers" });
    }

    const normalizedOfferPrice = Number(offerPrice);
    if (!Number.isFinite(normalizedOfferPrice) || normalizedOfferPrice <= 0) {
      return res.status(400).json({ message: "Valid offer price required" });
    }

    if (!product || !product.postId || !product.title) {
      return res.status(400).json({ message: "Product information required" });
    }
    if (!Types.ObjectId.isValid(String(product.postId))) {
      return res.status(400).json({ message: "Invalid product post ID" });
    }
    if (inquiryId && !Types.ObjectId.isValid(String(inquiryId))) {
      return res.status(400).json({ message: "Invalid inquiry ID" });
    }

    const chat = await Chat.findById(chatId);

    if (!chat) {
      return res.status(404).json({ message: "Chat not found" });
    }

    // Verify user is participant
    const isParticipant = chat.participants.some(
      (p) => p.toString() === userId?.toString()
    );

    if (!isParticipant) {
      return res.status(403).json({ message: "Not authorized" });
    }

    // Create offer product with new price
    const offerProduct = {
      postId: new Types.ObjectId(product.postId),
      title: product.title,
      price: normalizedOfferPrice,
      image: product.image || "",
      selectedSize:
        typeof product.selectedSize === "string" && product.selectedSize.trim().length > 0
          ? product.selectedSize.trim()
          : undefined,
    };

    // Create offer message
    const newMessage: IMessage = {
      _id: new Types.ObjectId(),
      chat: chat._id,
      sender: new Types.ObjectId(userId),
      content: `Offer price: Rs ${normalizedOfferPrice.toLocaleString("en-IN")}`,
      messageType: "product",
      product: offerProduct,
      inquiryId: inquiryId ? new Types.ObjectId(inquiryId) : chat.activeInquiryId,
      isRead: false,
      createdAt: new Date(),
    } as IMessage;
    chat.lastMessage = {
      content: `Offer: Rs ${normalizedOfferPrice.toLocaleString("en-IN")}`,
      sender: new Types.ObjectId(userId),
      createdAt: new Date(),
    };

    // Update inquiry status to replied if exists
    if (inquiryId || chat.activeInquiryId) {
      const targetInquiryId = inquiryId || chat.activeInquiryId?.toString();
      const inquiry = chat.inquiries.find(
        (i) => i._id?.toString() === targetInquiryId
      );
      if (inquiry && inquiry.status === "active") {
        inquiry.status = "replied";
      }
    }

    const savedMessageDoc = await Message.create(newMessage);
    await chat.save();

    // Get the saved message
    const savedMessage = savedMessageDoc.toObject();
    const activeInquiry =
      chat.activeInquiryId
        ? chat.inquiries.find((i) => toIdString(i._id) === toIdString(chat.activeInquiryId))
        : null;
    emitRealtimeChatEvent(chat, toIdString(userId), savedMessage, activeInquiry);

    return res.status(201).json({
      success: true,
      message: savedMessage,
      chatId: chat._id,
    });
  } catch (error) {
    console.error("Error in sendOfferPrice:", error);
    return res.status(500).json({ message: "Server error" });
  }
};

