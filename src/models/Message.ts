import { Schema, Document, model, Types } from "mongoose";

export interface IMessage extends Document {
  chat: Types.ObjectId;
  sender: Types.ObjectId;
  content: string;
  messageType: "text" | "image" | "product" | "inquiry" | "payment-request" | "order-update" | "delivery-confirmation" | "dispute";
  expiresAt?: Date;
  product?: {
    postId: Types.ObjectId;
    title: string;
    price: number;
    image: string;
    selectedSize?: string;
    sizeOptions?: string[];
  };
  inquiryId?: Types.ObjectId;
  replyTo?: {
    messageId: Types.ObjectId;
    content: string;
    senderName: string;
    messageType: string;
  };
  paymentRequest?: {
    amount: number;
    status: "pending" | "completed" | "cancelled";
    transactionId?: string;
  };
  orderUpdate?: {
    orderId: Types.ObjectId;
    orderNumber: string;
    status: string;
    previousStatus?: string;
    trackingNumber?: string;
    estimatedDelivery?: Date;
  };
  deliveryConfirmation?: {
    orderId: Types.ObjectId;
    orderNumber: string;
    confirmed?: boolean;
    confirmedAt?: Date;
  };
  disputeInfo?: {
    orderId: Types.ObjectId;
    orderNumber: string;
    itemName?: string;
  };
  isRead: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const messageSchema = new Schema<IMessage>(
  {
    chat: { type: Schema.Types.ObjectId, ref: "Chat", required: true, index: true },
    sender: { type: Schema.Types.ObjectId, ref: "User", required: true },
    content: { type: String, required: true },
    messageType: {
      type: String,
      enum: [
        "text",
        "image",
        "product",
        "inquiry",
        "payment-request",
        "order-update",
        "delivery-confirmation",
        "dispute",
      ],
      default: "text",
    },
    product: {
      postId: { type: Schema.Types.ObjectId, ref: "ImagePost" },
      title: String,
      price: Number,
      image: String,
      selectedSize: { type: String, trim: true },
      sizeOptions: [{ type: String, trim: true }],
    },
    inquiryId: { type: Schema.Types.ObjectId },
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
    disputeInfo: {
      orderId: { type: Schema.Types.ObjectId, ref: "Order" },
      orderNumber: String,
      itemName: String,
    },
    expiresAt: { type: Date, default: null },
    isRead: { type: Boolean, default: false },
  },
  { timestamps: true }
);

messageSchema.index({ chat: 1, createdAt: -1 });
messageSchema.index({ chat: 1, sender: 1, isRead: 1 });
// TTL index: auto-delete messages when expiresAt is reached
messageSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0, sparse: true });
messageSchema.index({ chat: 1, messageType: 1 });

export const Message = model<IMessage>("Message", messageSchema);

export default Message;
