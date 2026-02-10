import { Schema, Document, model, Types } from "mongoose";

// --- Inquiry Interface (for product inquiries) ---
export interface IInquiry {
  _id?: Types.ObjectId;
  product: {
    postId: Types.ObjectId;
    title: string;
    price: number;
    image: string;
  };
  status: "active" | "replied" | "closed";
  createdAt: Date;
  closedAt?: Date;
  firstMessageId?: Types.ObjectId;
}

// --- Message Interface ---
export interface IMessage {
  _id?: Types.ObjectId;
  sender: Types.ObjectId;
  content: string;
  messageType: "text" | "image" | "product" | "inquiry" | "payment-request" | "order-update" | "delivery-confirmation";
  // For product sharing (standalone product message)
  product?: {
    postId: Types.ObjectId;
    title: string;
    price: number;
    image: string;
  };
  // Link message to an inquiry (for grouping)
  inquiryId?: Types.ObjectId;
  // For reply/quote functionality (WhatsApp-style)
  replyTo?: {
    messageId: Types.ObjectId;
    content: string;
    senderName: string;
    messageType: string;
  };
  // For payment requests (future Razorpay integration)
  paymentRequest?: {
    amount: number;
    status: "pending" | "completed" | "cancelled";
    transactionId?: string;
  };
  // For order updates
  orderUpdate?: {
    orderId: Types.ObjectId;
    orderNumber: string;
    status: string;
    previousStatus?: string;
    trackingNumber?: string;
    estimatedDelivery?: Date;
  };
  // For delivery confirmation
  deliveryConfirmation?: {
    orderId: Types.ObjectId;
    orderNumber: string;
    confirmed?: boolean;
    confirmedAt?: Date;
  };
  isRead: boolean;
  createdAt: Date;
}

// --- Chat Interface ---
export interface IChat extends Document {
  participants: Types.ObjectId[];
  chatType: "general" | "business" | "admin"; // general-to-general, business-involved, admin-support
  // Track multiple product inquiries
  inquiries: IInquiry[];
  activeInquiryId?: Types.ObjectId; // Currently active inquiry
  // Legacy: single product context (deprecated, use inquiries)
  productContext?: {
    postId: Types.ObjectId;
    title: string;
    price: number;
    image: string;
  };
  messages: IMessage[];
  lastMessage?: {
    content: string;
    sender: Types.ObjectId;
    createdAt: Date;
  };
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

// --- Inquiry Schema ---
const inquirySchema = new Schema<IInquiry>(
  {
    product: {
      postId: { type: Schema.Types.ObjectId, ref: "ImagePost", required: true },
      title: { type: String, required: true },
      price: { type: Number, required: true },
      image: { type: String, required: true },
    },
    status: {
      type: String,
      enum: ["active", "replied", "closed"],
      default: "active",
    },
    closedAt: Date,
    firstMessageId: { type: Schema.Types.ObjectId },
  },
  { timestamps: true }
);

// --- Message Schema ---
const messageSchema = new Schema<IMessage>(
  {
    sender: { type: Schema.Types.ObjectId, ref: "User", required: true },
    content: { type: String, required: true },
    messageType: {
      type: String,
      enum: ["text", "image", "product", "inquiry", "payment-request", "order-update", "delivery-confirmation"],
      default: "text",
    },
    product: {
      postId: { type: Schema.Types.ObjectId, ref: "ImagePost" },
      title: String,
      price: Number,
      image: String,
    },
    // Link message to an inquiry
    inquiryId: { type: Schema.Types.ObjectId },
    // Reply/quote functionality
    replyTo: {
      messageId: { type: Schema.Types.ObjectId },
      content: String,
      senderName: String,
      messageType: String,
    },
    paymentRequest: {
      amount: Number,
      status: {
        type: String,
        enum: ["pending", "completed", "cancelled"],
        default: "pending",
      },
      transactionId: String,
    },
    orderUpdate: {
      orderId: { type: Schema.Types.ObjectId, ref: "Order" },
      orderNumber: String,
      status: String,
      previousStatus: String,
      trackingNumber: String,
      estimatedDelivery: Date,
    },
    deliveryConfirmation: {
      orderId: { type: Schema.Types.ObjectId, ref: "Order" },
      orderNumber: String,
      confirmed: { type: Boolean, default: false },
      confirmedAt: Date,
    },
    isRead: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// --- Chat Schema ---
const chatSchema = new Schema<IChat>(
  {
    participants: [
      { type: Schema.Types.ObjectId, ref: "User", required: true },
    ],
    chatType: {
      type: String,
      enum: ["general", "business", "admin"],
      default: "general",
    },
    // Multiple product inquiries
    inquiries: [inquirySchema],
    activeInquiryId: { type: Schema.Types.ObjectId },
    // Legacy: single product context (for backward compatibility)
    productContext: {
      postId: { type: Schema.Types.ObjectId, ref: "ImagePost" },
      title: String,
      price: Number,
      image: String,
    },
    // Legacy embedded messages (deprecated). Kept for migration only.
    // New messages are stored in the Message collection.
    messages: { type: [messageSchema], default: [], select: false },
    lastMessage: {
      content: String,
      sender: { type: Schema.Types.ObjectId, ref: "User" },
      createdAt: Date,
    },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

// --- Indexes for Performance ---
chatSchema.index({ participants: 1 });
chatSchema.index({ "lastMessage.createdAt": -1 });
chatSchema.index({ chatType: 1 });
chatSchema.index({ "inquiries.status": 1 });
chatSchema.index({ activeInquiryId: 1 });

export const Chat = model<IChat>("Chat", chatSchema);
