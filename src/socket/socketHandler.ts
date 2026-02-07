import { Server as HttpServer } from "http";
import { Server, Socket } from "socket.io";
import jwt from "jsonwebtoken";
import { Chat } from "../models/Chat.js";
import { Types } from "mongoose";

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

// Store online users: { odekId: socketId }
const onlineUsers = new Map<string, string>();

export function initializeSocket(server: HttpServer) {
  const io = new Server(server, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"],
    },
  });

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

  io.on("connection", (socket: AuthenticatedSocket) => {
    // Add user to online users
    if (socket.userId) {
      onlineUsers.set(socket.userId, socket.id);

      // Broadcast online status
      socket.broadcast.emit("user-online", { userId: socket.userId });
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
        const otherParticipant = chat.participants.find(p => p.toString() !== socket.userId);
        if (finalInquiryId) {
          const inquiry = chat.inquiries.find(i => i._id?.toString() === finalInquiryId?.toString());
          if (inquiry && inquiry.status === "active") {
            // Check if this is the seller (owner of the product) replying
            // For now, just mark as replied when the other person responds
            const firstMsg = chat.messages.find(m => m._id?.toString() === inquiry.firstMessageId?.toString());
            if (firstMsg && firstMsg.sender.toString() !== socket.userId) {
              inquiry.status = "replied";
            }
          }
        }

        // Create new message
        const newMessage = {
          _id: messageId,
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

        chat.messages.push(newMessage);
        chat.lastMessage = {
          content: startInquiry
            ? `📦 Inquiry: ${product?.title}`
            : messageType === "product"
              ? `📦 ${product?.title}`
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
            ...newMessage,
            sender: {
              _id: socket.userId,
            },
          },
          activeInquiry: activeInquiry || null,
        });

        // Notify other participants who might not be in the chat room
        chat.participants.forEach((participantId) => {
          if (participantId.toString() !== socket.userId) {
            const recipientSocketId = onlineUsers.get(participantId.toString());
            if (recipientSocketId) {
              io.to(recipientSocketId).emit("chat-notification", {
                chatId,
                message: newMessage,
                from: socket.userId,
              });
            }
          }
        });
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

        const chat = await Chat.findById(chatId);
        if (!chat) return;

        let updated = false;
        chat.messages.forEach((msg) => {
          if (msg.sender.toString() !== socket.userId && !msg.isRead) {
            msg.isRead = true;
            updated = true;
          }
        });

        if (updated) {
          await chat.save();
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
    socket.on("disconnect", () => {
      if (socket.userId) {
        onlineUsers.delete(socket.userId);
        socket.broadcast.emit("user-offline", { userId: socket.userId });
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

export function isUserOnline(userId: string): boolean {
  return onlineUsers.has(userId);
}
