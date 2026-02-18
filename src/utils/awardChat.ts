import { Types } from "mongoose";
import { Chat } from "../models/Chat.js";
import Message, { IMessage } from "../models/Message.js";
import {
  emitChatNotificationToUsers,
  emitMessageToChat,
} from "../socket/socketHandler.js";

const toIdString = (value: any): string => {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof value?.toString === "function") return value.toString();
  return String(value);
};

const toObjectId = (value: any): Types.ObjectId | null => {
  const stringValue = toIdString(value);
  if (!stringValue || !Types.ObjectId.isValid(stringValue)) return null;
  return new Types.ObjectId(stringValue);
};

const ensureAwardAdminChat = async (adminId: any, userId: any) => {
  const adminObjectId = toObjectId(adminId);
  const userObjectId = toObjectId(userId);
  if (!adminObjectId || !userObjectId) return null;

  let chat = await Chat.findOne({
    participants: { $all: [adminObjectId, userObjectId] },
    chatType: "admin",
    isActive: true,
  });

  if (!chat) {
    chat = new Chat({
      participants: [adminObjectId, userObjectId],
      chatType: "admin",
      requestStatus: "accepted",
      requestInitiator: adminObjectId,
      requestRecipient: userObjectId,
      isActive: true,
    });
    await chat.save();
  }

  return chat;
};

const emitAwardChatMessage = (chat: any, senderId: string, message: any) => {
  const chatId = toIdString(chat?._id);
  if (!chatId) return;

  const payloadMessage = {
    ...message,
    _id: toIdString(message?._id),
    sender: { _id: senderId },
    inquiryId: message?.inquiryId ? toIdString(message.inquiryId) : undefined,
  };

  emitMessageToChat(chatId, {
    chatId,
    message: payloadMessage,
  });

  const participants = (chat?.participants || []).map((p: any) => toIdString(p));
  emitChatNotificationToUsers(participants, senderId, {
    chatId,
    message: payloadMessage,
    from: senderId,
  });
};

export const sendAwardChatMessage = async ({
  adminId,
  userId,
  senderId,
  content,
}: {
  adminId: any;
  userId: any;
  senderId: any;
  content: string;
}) => {
  const trimmedContent = String(content || "").trim();
  if (!trimmedContent) return null;

  const senderObjectId = toObjectId(senderId);
  if (!senderObjectId) return null;

  const chat = await ensureAwardAdminChat(adminId, userId);
  if (!chat) return null;

  const messageDoc: IMessage = {
    _id: new Types.ObjectId(),
    chat: chat._id as any,
    sender: senderObjectId,
    content: trimmedContent,
    messageType: "text",
    isRead: false,
    createdAt: new Date(),
  } as IMessage;

  const savedMessage = await Message.create(messageDoc);
  chat.lastMessage = {
    content: trimmedContent,
    sender: senderObjectId,
    createdAt: new Date(),
  };
  await chat.save();

  emitAwardChatMessage(chat, toIdString(senderObjectId), savedMessage.toObject());
  return savedMessage;
};

