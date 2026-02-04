import mongoose, { Schema, Document } from "mongoose";

export type NotificationType = 
  | "like"
  | "comment"
  | "follow"
  | "order_placed"
  | "order_confirmed"
  | "order_shipped"
  | "order_delivered"
  | "order_cancelled"
  | "mention"
  | "system";

export interface INotification extends Document {
  recipient: mongoose.Types.ObjectId;      // User who receives the notification
  sender?: mongoose.Types.ObjectId;        // User who triggered (for social actions)
  type: NotificationType;
  title: string;
  message: string;
  
  // Related entities
  post?: mongoose.Types.ObjectId;          // For likes, comments
  comment?: mongoose.Types.ObjectId;       // For comment notifications
  order?: mongoose.Types.ObjectId;         // For order notifications
  
  // Status
  read: boolean;
  readAt?: Date;
  
  // Metadata
  metadata?: Record<string, any>;
  
  createdAt: Date;
  updatedAt: Date;
}

const notificationSchema = new Schema<INotification>(
  {
    recipient: { 
      type: Schema.Types.ObjectId, 
      ref: "User", 
      required: true,
      index: true 
    },
    sender: { 
      type: Schema.Types.ObjectId, 
      ref: "User"
    },
    type: { 
      type: String, 
      enum: [
        "like", 
        "comment", 
        "follow", 
        "order_placed", 
        "order_confirmed", 
        "order_shipped", 
        "order_delivered", 
        "order_cancelled",
        "mention",
        "system"
      ],
      required: true,
      index: true
    },
    title: { 
      type: String, 
      required: true,
      trim: true
    },
    message: { 
      type: String, 
      required: true,
      trim: true
    },
    
    // Related entities
    post: { type: Schema.Types.ObjectId, ref: "ImagePost" },
    comment: { type: Schema.Types.ObjectId, ref: "Comment" },
    order: { type: Schema.Types.ObjectId, ref: "Order" },
    
    // Status
    read: { type: Boolean, default: false, index: true },
    readAt: { type: Date },
    
    // Additional metadata (flexible for future use)
    metadata: { type: Schema.Types.Mixed }
  },
  { timestamps: true }
);

// Compound index for efficient queries
notificationSchema.index({ recipient: 1, read: 1, createdAt: -1 });
notificationSchema.index({ recipient: 1, type: 1, createdAt: -1 });

// TTL index to auto-delete old notifications (90 days)
notificationSchema.index(
  { createdAt: 1 }, 
  { expireAfterSeconds: 90 * 24 * 60 * 60 } // 90 days
);

export default mongoose.model<INotification>("Notification", notificationSchema);
