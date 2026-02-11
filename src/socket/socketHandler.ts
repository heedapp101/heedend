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
}

// Store local online sockets per user (fallback/debug)
const onlineUsers = new Map<string, Set<string>>();
const getUserRoom = (userId: string) => `user:${userId}`;
let ioInstance: Server | null = null;

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
        const { chatId, content, messageType = "text", product, paymentRequest, startInquiry, inquiryId, replyTo } = payload;

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

        chat.lastMessage = {
          content: startInquiry
            ? `Inquiry: ${product?.title || "Product"}`
            : messageType === "product"
              ? `Product: ${product?.title || "Product"}`
              : messageType === "image"
                ? "Photo"
                : content,
          sender: new Types.ObjectId(socket.userId),
          createdAt: new Date(),
        };

        await chat.save();

        // Get active inquiry for response
        const activeInquiry = chat.inquiries.find(i => i._id?.toString() === chat.activeInquiryId?.toString());

        // Emit to all users in the chat room
        io.to(chatId).emit("new-message", {
          chatId,
          message: {
            ...savedMessage.toObject(),
            sender: {
              _id: socket.userId,
            },
          },
          activeInquiry: activeInquiry || null,
        });

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

        // Business auto-reply for non-business sender
        try {
          const recipientIds = chat.participants
            .map((p) => p.toString())
            .filter((id) => id !== socket.userId);

          const businessRecipient = await User.findOne({
            _id: { $in: recipientIds },
            userType: "business",
            autoReplyEnabled: true,
          }).select("autoReplyEnabled autoReplyMessage");

          if (businessRecipient && socket.userType !== "business") {
            const isInquiryMessage = messageType === "inquiry" || startInquiry;
            const autoReplyInquiryId = finalInquiryId || chat.activeInquiryId;

            const resolveInquiryProduct = () => {
              if (product?.postId && Types.ObjectId.isValid(String(product.postId))) {
                return {
                  postId: new Types.ObjectId(product.postId),
                  title: product.title || "",
                  price: Number(product.price || 0),
                  image: product.image || "",
                };
              }

              if (autoReplyInquiryId) {
                const linkedInquiry = chat.inquiries.find(
                  (inquiry) => inquiry._id?.toString() === autoReplyInquiryId.toString()
                );
                if (linkedInquiry) {
                  return {
                    postId: linkedInquiry.product.postId,
                    title: linkedInquiry.product.title || "",
                    price: linkedInquiry.product.price || 0,
                    image: linkedInquiry.product.image || "",
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

              if (!existingAutoProductReply) {
                const autoReplyCtaText = "Tap Buy Now or Negotiate below.";
                const autoReplyMessage = {
                  _id: new Types.ObjectId(),
                  chat: chat._id,
                  sender: new Types.ObjectId(businessRecipient._id),
                  content: autoReplyCtaText,
                  messageType: "product" as const,
                  product: inquiryProduct,
                  inquiryId: autoReplyInquiryId,
                  isRead: false,
                  createdAt: new Date(),
                };

                const savedAutoReply = await Message.create(autoReplyMessage);
                chat.lastMessage = {
                  content: `Product: ${inquiryProduct.title || "Product"}`,
                  sender: new Types.ObjectId(businessRecipient._id),
                  createdAt: new Date(),
                };
                await chat.save();

                io.to(chatId).emit("new-message", {
                  chatId,
                  message: {
                    ...savedAutoReply.toObject(),
                    sender: {
                      _id: businessRecipient._id.toString(),
                    },
                  },
                  activeInquiry: activeInquiry || null,
                });
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
                const autoReplyMessage = {
                  _id: new Types.ObjectId(),
                  chat: chat._id,
                  sender: new Types.ObjectId(businessRecipient._id),
                  content: autoReplyText,
                  messageType: "text" as const,
                  isRead: false,
                  createdAt: new Date(),
                  inquiryId: finalInquiryId,
                };

                const savedAutoReply = await Message.create(autoReplyMessage);
                chat.lastMessage = {
                  content: autoReplyText,
                  sender: new Types.ObjectId(businessRecipient._id),
                  createdAt: new Date(),
                };
                await chat.save();

                io.to(chatId).emit("new-message", {
                  chatId,
                  message: {
                    ...savedAutoReply.toObject(),
                    sender: {
                      _id: businessRecipient._id.toString(),
                    },
                  },
                  activeInquiry: activeInquiry || null,
                });
              }
            }
          }
        } catch (autoReplyError) {
          console.error("Socket auto-reply error:", autoReplyError);
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

        const chat = await Chat.findById(chatId).select("_id");
        if (!chat) return;

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
