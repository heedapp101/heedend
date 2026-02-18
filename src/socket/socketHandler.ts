import { Server as HttpServer } from "http";
import { Server, Socket } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import jwt from "jsonwebtoken";
import { Chat } from "../models/Chat.js";
import Message from "../models/Message.js";
import { Types } from "mongoose";
import User from "../models/User.js";
import { getRedisPubSubClients } from "../config/redis.js";
import { markUserOnline, markUserOffline, isUserOnline as isUserOnlineStore } from "../utils/presenceStore.js";
import { sendChatNotification } from "../utils/pushNotifications.js";

interface AuthenticatedSocket extends Socket {
  userId?: string;
  userType?: string;
}

interface MessagePayload {
  chatId: string;
  content: string;
  messageType?: "text" | "image" | "product" | "inquiry" | "payment-request";
  product?: {
    postId: string;
    title: string;
    price: number;
    image: string;
    selectedSize?: string;
    hasSizeVariants?: boolean;
    sizeOptions?: string[];
  };
  // For starting a new inquiry
  startInquiry?: boolean;
  inquiryId?: string;
  // For reply/quote
  replyTo?: {
    messageId: string;
    content: string;
    senderName: string;
    messageType: string;
  };
  paymentRequest?: {
    amount: number;
  };
  // When user presses "Negotiate" button
  negotiate?: boolean;
}

// Store local online sockets per user (fallback/debug)
const onlineUsers = new Map<string, Set<string>>();
const getUserRoom = (userId: string) => `user:${userId}`;
let ioInstance: Server | null = null;
const READ_RECEIPT_THROTTLE_MS = 1200;
const readReceiptThrottleMap = new Map<string, number>();

const toIdString = (value: any): string => {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof value?.toString === "function") return value.toString();
  return String(value);
};

const canSocketUserSendInChat = (chat: any, userId?: string) => {
  const requestStatus = String(chat?.requestStatus || "none");
  const requestRecipient = toIdString(chat?.requestRecipient);
  const blockedBy = toIdString(chat?.blockedBy);
  const currentUserId = toIdString(userId);

  if (!currentUserId) {
    return { allowed: false, message: "Not authenticated" };
  }

  if (requestStatus === "blocked") {
    if (blockedBy && blockedBy !== currentUserId) {
      return { allowed: false, message: "You are blocked in this chat" };
    }
    return { allowed: false, message: "This chat is blocked" };
  }

  if (requestStatus === "pending" && requestRecipient === currentUserId) {
    return { allowed: false, message: "Accept this message request before replying" };
  }

  return { allowed: true };
};

const shouldThrottleReadReceipt = (userId: string, chatId: string) => {
  const key = `${userId}:${chatId}`;
  const now = Date.now();
  const lastUpdated = readReceiptThrottleMap.get(key) || 0;
  if (now - lastUpdated < READ_RECEIPT_THROTTLE_MS) {
    return true;
  }
  readReceiptThrottleMap.set(key, now);
  return false;
};

const clearReadReceiptThrottleForUser = (userId: string) => {
  const userKeyPrefix = `${userId}:`;
  Array.from(readReceiptThrottleMap.keys()).forEach((key) => {
    if (key.startsWith(userKeyPrefix)) {
      readReceiptThrottleMap.delete(key);
    }
  });
};

const getMessagePreviewText = ({
  content,
  messageType,
  product,
  paymentRequest,
  startInquiry,
}: {
  content?: string;
  messageType: NonNullable<MessagePayload["messageType"]>;
  product?: MessagePayload["product"];
  paymentRequest?: MessagePayload["paymentRequest"];
  startInquiry?: boolean;
}) => {
  if (startInquiry) {
    return `Inquiry: ${product?.title || "Product"}`;
  }
  if (messageType === "product") {
    return `Product: ${product?.title || "Product"}`;
  }
  if (messageType === "image") {
    return "Photo";
  }
  if (messageType === "payment-request") {
    const amount = Number(paymentRequest?.amount || 0);
    return amount > 0 ? `Payment request: INR ${amount}` : "Payment request";
  }
  const trimmedContent = String(content || "").trim();
  return trimmedContent.length > 0 ? trimmedContent : "New message";
};

export const emitMessageToChat = (chatId: string, payload: any) => {
  const io = ioInstance;
  if (!io) return;
  io.to(chatId).emit("new-message", payload);
};

export const emitChatNotificationToUsers = (
  participantIds: string[],
  senderId: string,
  payload: any
) => {
  const io = ioInstance;
  if (!io) return;
  participantIds.forEach((participantId) => {
    if (participantId === senderId) return;
    io.to(getUserRoom(participantId)).emit("chat-notification", payload);
  });
};

const emitRealtimeMessage = (
  io: Server,
  chatId: string,
  senderId: string,
  message: any,
  activeInquiry?: any
) => {
  io.to(chatId).emit("new-message", {
    chatId,
    message: {
      ...message,
      sender: {
        _id: senderId,
      },
    },
    activeInquiry: activeInquiry || null,
  });
};

interface AutoReplyParams {
  io: Server;
  chatId: string;
  chat: any;
  senderId: string;
  messageType: NonNullable<MessagePayload["messageType"]>;
  product?: MessagePayload["product"];
  startInquiry?: boolean;
  finalInquiryId?: Types.ObjectId;
  activeInquiry?: any;
  negotiate?: boolean;
}

const processBusinessAutoReply = async ({
  io,
  chatId,
  chat,
  senderId,
  messageType,
  product,
  startInquiry,
  finalInquiryId,
  activeInquiry,
  negotiate,
}: AutoReplyParams) => {
  const recipientIds = chat.participants
    .map((p: Types.ObjectId) => p.toString())
    .filter((id: string) => id !== senderId);

  const businessRecipient = await User.findOne({
    _id: { $in: recipientIds },
    userType: "business",
    autoReplyEnabled: true,
  }).select("autoReplyEnabled autoReplyMessage");

  if (!businessRecipient) return;

  const isInquiryMessage = messageType === "inquiry" || startInquiry;
  const autoReplyInquiryId = finalInquiryId || chat.activeInquiryId;
  const incomingSizeOptions = Array.isArray(product?.sizeOptions)
    ? product.sizeOptions
        .map((size) => String(size || "").trim())
        .filter((size) => size.length > 0)
    : [];
  const hasSelectedSize =
    typeof product?.selectedSize === "string" && product.selectedSize.trim().length > 0;
  const shouldPromptSelectSize =
    isInquiryMessage && incomingSizeOptions.length > 0 && !hasSelectedSize;

  if (negotiate) {
    const negotiateReplyText = "We'll reply you shortly.";
    const savedAutoReply = await Message.create({
      _id: new Types.ObjectId(),
      chat: chat._id,
      sender: new Types.ObjectId(businessRecipient._id),
      content: negotiateReplyText,
      messageType: "text",
      inquiryId: autoReplyInquiryId,
      isRead: false,
      createdAt: new Date(),
    });

    chat.lastMessage = {
      content: negotiateReplyText,
      sender: new Types.ObjectId(businessRecipient._id),
      createdAt: new Date(),
    };
    await chat.save();

    emitRealtimeMessage(
      io,
      chatId,
      businessRecipient._id.toString(),
      savedAutoReply.toObject(),
      activeInquiry
    );
    return;
  }

  const resolveInquiryProduct = () => {
    if (product?.postId && Types.ObjectId.isValid(String(product.postId))) {
      return {
        postId: new Types.ObjectId(product.postId),
        title: product.title || "",
        price: Number(product.price || 0),
        image: product.image || "",
        selectedSize:
          typeof product.selectedSize === "string" && product.selectedSize.trim().length > 0
            ? product.selectedSize.trim()
            : undefined,
        sizeOptions: incomingSizeOptions,
      };
    }

    if (autoReplyInquiryId) {
      const linkedInquiry = chat.inquiries.find(
        (inquiry: any) => inquiry._id?.toString() === autoReplyInquiryId.toString()
      );
      if (linkedInquiry) {
        return {
          postId: linkedInquiry.product.postId,
          title: linkedInquiry.product.title || "",
          price: linkedInquiry.product.price || 0,
          image: linkedInquiry.product.image || "",
          selectedSize:
            typeof linkedInquiry.product.selectedSize === "string" &&
            linkedInquiry.product.selectedSize.trim().length > 0
              ? linkedInquiry.product.selectedSize.trim()
              : undefined,
          sizeOptions: Array.isArray((linkedInquiry.product as any)?.sizeOptions)
            ? (linkedInquiry.product as any).sizeOptions
                .map((size: any) => String(size || "").trim())
                .filter((size: string) => size.length > 0)
            : [],
        };
      }
    }

    return null;
  };

  const inquiryProduct = isInquiryMessage ? resolveInquiryProduct() : null;
  if (isInquiryMessage && inquiryProduct && autoReplyInquiryId) {
    const existingAutoProductReply = await Message.findOne({
      chat: chat._id,
      sender: businessRecipient._id,
      messageType: "product",
      inquiryId: autoReplyInquiryId,
    })
      .sort({ createdAt: -1 })
      .lean();

    if (existingAutoProductReply) return;

    if (shouldPromptSelectSize) {
      const savedSizePrompt = await Message.create({
        _id: new Types.ObjectId(),
        chat: chat._id,
        sender: new Types.ObjectId(businessRecipient._id),
        content: "Choose a size from the buttons below to continue.",
        messageType: "text",
        inquiryId: autoReplyInquiryId,
        isRead: false,
        createdAt: new Date(),
      });

      emitRealtimeMessage(
        io,
        chatId,
        businessRecipient._id.toString(),
        savedSizePrompt.toObject(),
        activeInquiry
      );
    }

    const autoReplyCtaText = shouldPromptSelectSize
      ? "Choose size, then tap Buy Now or Negotiate below."
      : "Tap Buy Now or Negotiate below.";
    const savedAutoReply = await Message.create({
      _id: new Types.ObjectId(),
      chat: chat._id,
      sender: new Types.ObjectId(businessRecipient._id),
      content: autoReplyCtaText,
      messageType: "product",
      product: inquiryProduct,
      inquiryId: autoReplyInquiryId,
      isRead: false,
      createdAt: new Date(),
    });

    chat.lastMessage = {
      content: `Product: ${inquiryProduct.title || "Product"}`,
      sender: new Types.ObjectId(businessRecipient._id),
      createdAt: new Date(),
    };
    await chat.save();

    emitRealtimeMessage(
      io,
      chatId,
      businessRecipient._id.toString(),
      savedAutoReply.toObject(),
      activeInquiry
    );
    return;
  }

  const autoReplyText =
    businessRecipient.autoReplyMessage?.trim() ||
    "Thanks for your message. We will reply soon.";
  const recentlySentSameReply = await Message.findOne({
    chat: chat._id,
    sender: businessRecipient._id,
    content: autoReplyText,
  })
    .sort({ createdAt: -1 })
    .lean();
  const now = Date.now();
  if (
    recentlySentSameReply &&
    now - new Date(recentlySentSameReply.createdAt).getTime() < 90 * 1000
  ) {
    return;
  }

  const savedAutoReply = await Message.create({
    _id: new Types.ObjectId(),
    chat: chat._id,
    sender: new Types.ObjectId(businessRecipient._id),
    content: autoReplyText,
    messageType: "text",
    isRead: false,
    createdAt: new Date(),
    inquiryId: finalInquiryId,
  });

  chat.lastMessage = {
    content: autoReplyText,
    sender: new Types.ObjectId(businessRecipient._id),
    createdAt: new Date(),
  };
  await chat.save();

  emitRealtimeMessage(
    io,
    chatId,
    businessRecipient._id.toString(),
    savedAutoReply.toObject(),
    activeInquiry
  );
};

export async function initializeSocket(server: HttpServer) {
  const io = new Server(server, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"],
    },
  });
  ioInstance = io;

  try {
    const { pubClient, subClient } = await getRedisPubSubClients();
    io.adapter(createAdapter(pubClient, subClient));
    console.log("Socket.io Redis adapter enabled");
  } catch (error) {
    console.warn("Redis adapter not available, using in-memory adapter:", error);
  }

  // Authentication middleware
  io.use((socket: AuthenticatedSocket, next) => {
    const token = socket.handshake.auth.token || socket.handshake.query.token;

    if (!token) {
      return next(new Error("Authentication required"));
    }

    try {
      const decoded = jwt.verify(
        token as string,
        process.env.JWT_SECRET || "your-jwt-secret"
      ) as { _id: string; userType: string };

      socket.userId = decoded._id;
      socket.userType = decoded.userType;
      next();
    } catch (err) {
      next(new Error("Invalid token"));
    }
  });

  io.on("connection", async (socket: AuthenticatedSocket) => {
    // Add user to online users
    if (socket.userId) {
      socket.join(getUserRoom(socket.userId));

      const localSockets = onlineUsers.get(socket.userId) || new Set<string>();
      localSockets.add(socket.id);
      onlineUsers.set(socket.userId, localSockets);

      const isFirstConnection = await markUserOnline(socket.userId, socket.id);
      if (isFirstConnection) {
        socket.broadcast.emit("user-online", { userId: socket.userId });
      }
    }

    // --- Join Chat Room ---
    socket.on("join-chat", (chatId: string) => {
      socket.join(chatId);
    });

    // --- Leave Chat Room ---
    socket.on("leave-chat", (chatId: string) => {
      socket.leave(chatId);
    });

    // --- Send Message ---
    socket.on("send-message", async (payload: MessagePayload) => {
      try {
        const { chatId, content, messageType = "text", product, paymentRequest, startInquiry, inquiryId, replyTo, negotiate } = payload;

        if (!socket.userId) {
          socket.emit("error", { message: "Not authenticated" });
          return;
        }

        const chat = await Chat.findById(chatId);
        if (!chat) {
          socket.emit("error", { message: "Chat not found" });
          return;
        }

        // Verify user is participant
        const isParticipant = chat.participants.some(
          (p) => p.toString() === socket.userId
        );

        if (!isParticipant) {
          socket.emit("error", { message: "Not authorized" });
          return;
        }

        const sendAccess = canSocketUserSendInChat(chat, socket.userId);
        if (!sendAccess.allowed) {
          socket.emit("error", { message: sendAccess.message || "Message request pending" });
          return;
        }

        const messageId = new Types.ObjectId();
        let finalInquiryId: Types.ObjectId | undefined;

        // Handle inquiry creation/linking
        if (startInquiry && product) {
          // Create new inquiry
          const newInquiry = {
            _id: new Types.ObjectId(),
            product: {
              postId: new Types.ObjectId(product.postId),
              title: product.title || "",
              price: product.price || 0,
              image: product.image || "",
              selectedSize:
                typeof product.selectedSize === "string" && product.selectedSize.trim().length > 0
                  ? product.selectedSize.trim()
                  : undefined,
              sizeOptions: Array.isArray(product.sizeOptions)
                ? product.sizeOptions
                    .map((size) => String(size || "").trim())
                    .filter((size) => size.length > 0)
                : [],
            },
            status: "active" as const,
            createdAt: new Date(),
            firstMessageId: messageId,
          };
          chat.inquiries.push(newInquiry);
          chat.activeInquiryId = newInquiry._id;
          finalInquiryId = newInquiry._id;
        } else if (inquiryId) {
          // Link to existing inquiry
          finalInquiryId = new Types.ObjectId(inquiryId);
        } else if (chat.activeInquiryId) {
          // Auto-link to active inquiry
          finalInquiryId = chat.activeInquiryId;
        }

        // If seller is replying, mark inquiry as replied
        if (finalInquiryId) {
          const inquiry = chat.inquiries.find(i => i._id?.toString() === finalInquiryId?.toString());
          if (inquiry && inquiry.status === "active" && inquiry.firstMessageId) {
            const firstMsg = await Message.findById(inquiry.firstMessageId).select("sender").lean();
            if (firstMsg && firstMsg.sender.toString() !== socket.userId) {
              inquiry.status = "replied";
            }
          }
        }

        // Create new message
        const newMessage = {
          _id: messageId,
          chat: chat._id,
          sender: new Types.ObjectId(socket.userId),
          content,
          messageType: startInquiry ? "inquiry" : messageType,
          product: (messageType === "product" || startInquiry) && product ? {
            postId: new Types.ObjectId(product.postId),
            title: product.title || "",
            price: product.price || 0,
            image: product.image || "",
            selectedSize:
              typeof product.selectedSize === "string" && product.selectedSize.trim().length > 0
                ? product.selectedSize.trim()
                : undefined,
            sizeOptions: Array.isArray(product.sizeOptions)
              ? product.sizeOptions
                  .map((size) => String(size || "").trim())
                  .filter((size) => size.length > 0)
              : [],
          } : undefined,
          inquiryId: finalInquiryId,
          replyTo: replyTo ? {
            messageId: new Types.ObjectId(replyTo.messageId),
            content: replyTo.content,
            senderName: replyTo.senderName,
            messageType: replyTo.messageType,
          } : undefined,
          paymentRequest: messageType === "payment-request" ? {
            amount: paymentRequest?.amount || 0,
            status: "pending" as const,
          } : undefined,
          isRead: false,
          createdAt: new Date(),
        };

        const savedMessage = await Message.create(newMessage);
        const messagePreviewText = getMessagePreviewText({
          content,
          messageType: startInquiry ? "inquiry" : messageType,
          product,
          paymentRequest,
          startInquiry,
        });

        chat.lastMessage = {
          content: messagePreviewText,
          sender: new Types.ObjectId(socket.userId),
          createdAt: new Date(),
        };

        await chat.save();

        // Get active inquiry for response
        const activeInquiry = chat.inquiries.find(
          (i) => i._id?.toString() === chat.activeInquiryId?.toString()
        );

        // Emit sender message immediately on critical path
        emitRealtimeMessage(
          io,
          chatId,
          socket.userId,
          savedMessage.toObject(),
          activeInquiry
        );

        // Notify other participants who might not be in the chat room
        chat.participants.forEach((participantId) => {
          if (participantId.toString() !== socket.userId) {
            io.to(getUserRoom(participantId.toString())).emit("chat-notification", {
              chatId,
              message: savedMessage.toObject(),
              from: socket.userId,
            });
          }
        });

        // Send push notifications only to recipients who are currently offline.
        const recipientIds = chat.participants
          .map((participantId) => participantId.toString())
          .filter((participantId) => participantId !== socket.userId);
        if (recipientIds.length > 0) {
          void (async () => {
            try {
              const sender = await User.findById(socket.userId).select("name username").lean();
              const senderName =
                String((sender as any)?.name || "").trim() ||
                String((sender as any)?.username || "").trim() ||
                "Someone";

              await Promise.allSettled(
                recipientIds.map(async (recipientId) => {
                  const recipientOnline = await isUserOnlineStore(recipientId);
                  if (recipientOnline) return;
                  await sendChatNotification(
                    socket.userId as string,
                    recipientId,
                    senderName,
                    messagePreviewText,
                    chatId
                  );
                })
              );
            } catch (pushError) {
              console.error("Chat push notification error:", pushError);
            }
          })();
        }

        // Run business auto-reply in background to keep send-message path responsive
        if (String(chat.requestStatus || "none") !== "pending") {
          void processBusinessAutoReply({
            io,
            chatId,
            chat,
            senderId: socket.userId,
            messageType: startInquiry ? "inquiry" : messageType,
            product,
            startInquiry,
            finalInquiryId,
            activeInquiry,
            negotiate,
          }).catch((autoReplyError) => {
            console.error("Auto-reply error:", autoReplyError);
          });
        }
      } catch (error) {
        console.error("Error sending message:", error);
        socket.emit("error", { message: "Failed to send message" });
      }
    });

    // --- Typing Indicator ---
    socket.on("typing", (chatId: string) => {
      socket.to(chatId).emit("user-typing", {
        chatId,
        userId: socket.userId,
      });
    });

    socket.on("stop-typing", (chatId: string) => {
      socket.to(chatId).emit("user-stop-typing", {
        chatId,
        userId: socket.userId,
      });
    });

    // --- Mark Messages as Read ---
    socket.on("mark-read", async (chatId: string) => {
      try {
        if (!socket.userId) return;
        if (shouldThrottleReadReceipt(socket.userId, chatId)) return;

        const updateResult = await Message.updateMany(
          { chat: chatId, sender: { $ne: socket.userId }, isRead: false },
          { $set: { isRead: true } }
        );

        if ((updateResult as any).modifiedCount > 0) {
          // Notify sender that messages were read
          socket.to(chatId).emit("messages-read", {
            chatId,
            readBy: socket.userId,
          });
        }
      } catch (error) {
        console.error("Error marking messages read:", error);
      }
    });

    // --- Disconnect ---
    socket.on("disconnect", async () => {
      if (socket.userId) {
        clearReadReceiptThrottleForUser(socket.userId);

        const localSockets = onlineUsers.get(socket.userId);
        if (localSockets) {
          localSockets.delete(socket.id);
          if (localSockets.size === 0) {
            onlineUsers.delete(socket.userId);
          } else {
            onlineUsers.set(socket.userId, localSockets);
          }
        }

        const isLastConnection = await markUserOffline(socket.userId, socket.id);
        if (isLastConnection) {
          socket.broadcast.emit("user-offline", { userId: socket.userId });
        }
      }
    });
  });

  // Helper function to get online status
  (global as any).getOnlineUsers = () => onlineUsers;
  (global as any).io = io;

  return io;
}

// Export for use in other parts of the app
export function getIO() {
  return (global as any).io;
}

export async function isUserOnline(userId: string): Promise<boolean> {
  return isUserOnlineStore(userId);
}



