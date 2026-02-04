import mongoose, { Schema, Document } from "mongoose";

// Order Status Flow:
// pending -> confirmed -> processing -> shipped -> delivered
// pending -> cancelled (can be cancelled before shipped)
// Any status can go to -> refund_requested -> refunded

export type OrderStatus = 
  | "pending"           // Order placed, waiting for seller confirmation
  | "confirmed"         // Seller confirmed the order
  | "processing"        // Order is being prepared
  | "shipped"           // Order has been shipped
  | "out_for_delivery"  // Order is out for delivery
  | "delivered"         // Order delivered successfully
  | "cancelled"         // Order cancelled
  | "refund_requested"  // Buyer requested refund
  | "refunded";         // Refund completed

export type PaymentMethod = "cod" | "online";
export type PaymentStatus = "pending" | "completed" | "failed" | "refunded";

export interface IOrderItem {
  post: mongoose.Types.ObjectId;
  title: string;
  price: number;
  quantity: number;
  image: string;
}

export interface IShippingAddress {
  fullName: string;
  phone: string;
  addressLine1: string;
  addressLine2?: string;
  city: string;
  state: string;
  pincode: string;
  landmark?: string;
}

export interface IOrder extends Document {
  orderNumber: string;
  buyer: mongoose.Types.ObjectId;
  seller: mongoose.Types.ObjectId;
  items: IOrderItem[];
  
  // Pricing
  subtotal: number;
  shippingCharge: number;
  discount: number;
  totalAmount: number;
  
  // Payment
  paymentMethod: PaymentMethod;
  paymentStatus: PaymentStatus;
  transactionId?: string;
  paidAt?: Date;
  
  // Shipping
  shippingAddress: IShippingAddress;
  trackingNumber?: string;
  shippingCarrier?: string;
  estimatedDelivery?: Date;
  deliveredAt?: Date;
  
  // Status
  status: OrderStatus;
  statusHistory: Array<{
    status: OrderStatus;
    timestamp: Date;
    note?: string;
    updatedBy?: mongoose.Types.ObjectId;
  }>;
  
  // Communication
  chatId?: mongoose.Types.ObjectId;
  buyerNotes?: string;
  sellerNotes?: string;
  
  // Cancellation/Refund
  cancellationReason?: string;
  cancelledBy?: mongoose.Types.ObjectId;
  refundAmount?: number;
  refundReason?: string;
  
  createdAt: Date;
  updatedAt: Date;
}

const orderItemSchema = new Schema<IOrderItem>(
  {
    post: { type: Schema.Types.ObjectId, ref: "ImagePost", required: true },
    title: { type: String, required: true },
    price: { type: Number, required: true, min: 0 },
    quantity: { type: Number, required: true, min: 1, default: 1 },
    image: { type: String, required: true },
  },
  { _id: false }
);

const shippingAddressSchema = new Schema<IShippingAddress>(
  {
    fullName: { type: String, required: true, trim: true },
    phone: { type: String, required: true, trim: true },
    addressLine1: { type: String, required: true, trim: true },
    addressLine2: { type: String, trim: true },
    city: { type: String, required: true, trim: true },
    state: { type: String, required: true, trim: true },
    pincode: { type: String, required: true, trim: true },
    landmark: { type: String, trim: true },
  },
  { _id: false }
);

const statusHistorySchema = new Schema(
  {
    status: { 
      type: String, 
      enum: ["pending", "confirmed", "processing", "shipped", "out_for_delivery", "delivered", "cancelled", "refund_requested", "refunded"],
      required: true 
    },
    timestamp: { type: Date, default: Date.now },
    note: { type: String },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { _id: false }
);

const orderSchema = new Schema<IOrder>(
  {
    orderNumber: { type: String, required: true, unique: true },
    buyer: { type: Schema.Types.ObjectId, ref: "User", required: true },
    seller: { type: Schema.Types.ObjectId, ref: "User", required: true },
    items: { type: [orderItemSchema], required: true },
    
    // Pricing
    subtotal: { type: Number, required: true, min: 0 },
    shippingCharge: { type: Number, default: 0, min: 0 },
    discount: { type: Number, default: 0, min: 0 },
    totalAmount: { type: Number, required: true, min: 0 },
    
    // Payment
    paymentMethod: { 
      type: String, 
      enum: ["cod", "online"], 
      required: true 
    },
    paymentStatus: { 
      type: String, 
      enum: ["pending", "completed", "failed", "refunded"], 
      default: "pending" 
    },
    transactionId: { type: String },
    paidAt: { type: Date },
    
    // Shipping
    shippingAddress: { type: shippingAddressSchema, required: true },
    trackingNumber: { type: String },
    shippingCarrier: { type: String },
    estimatedDelivery: { type: Date },
    deliveredAt: { type: Date },
    
    // Status
    status: { 
      type: String, 
      enum: ["pending", "confirmed", "processing", "shipped", "out_for_delivery", "delivered", "cancelled", "refund_requested", "refunded"],
      default: "pending" 
    },
    statusHistory: { type: [statusHistorySchema], default: [] },
    
    // Communication
    chatId: { type: Schema.Types.ObjectId, ref: "Chat" },
    buyerNotes: { type: String },
    sellerNotes: { type: String },
    
    // Cancellation/Refund
    cancellationReason: { type: String },
    cancelledBy: { type: Schema.Types.ObjectId, ref: "User" },
    refundAmount: { type: Number },
    refundReason: { type: String },
  },
  { timestamps: true }
);

// Indexes for efficient queries
orderSchema.index({ orderNumber: 1 });
orderSchema.index({ buyer: 1, createdAt: -1 });
orderSchema.index({ seller: 1, createdAt: -1 });
orderSchema.index({ status: 1 });
orderSchema.index({ paymentStatus: 1 });
orderSchema.index({ createdAt: -1 });
orderSchema.index({ seller: 1, status: 1 }); // Seller dashboard queries

// Generate unique order number
orderSchema.pre("save", async function (next) {
  if (this.isNew && !this.orderNumber) {
    const timestamp = Date.now().toString(36).toUpperCase();
    const random = Math.random().toString(36).substring(2, 6).toUpperCase();
    this.orderNumber = `ORD-${timestamp}-${random}`;
  }
  
  // Add initial status to history if new
  if (this.isNew && this.statusHistory.length === 0) {
    this.statusHistory.push({
      status: this.status,
      timestamp: new Date(),
    });
  }
  
  next();
});

export default mongoose.model<IOrder>("Order", orderSchema);
