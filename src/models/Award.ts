import mongoose, { Schema, Document, Types } from "mongoose";

export interface IAward extends Document {
  type: "post" | "user";
  targetPost?: Types.ObjectId;
  targetUser: Types.ObjectId;
  message: string;
  amount: number;
  status: "pending" | "approved" | "paid" | "rejected";
  showInFeed: boolean;
  priority: number;
  awardedBy: Types.ObjectId; // Admin who gave the award
  paidAt?: Date;
  paymentMethod?: {
    type: "upi" | "phone";
    value: string;
  };
  createdAt: Date;
  updatedAt: Date;
}

const awardSchema = new Schema<IAward>(
  {
    // Award type: either for a post or directly for a user
    type: {
      type: String,
      enum: ["post", "user"],
      required: true,
    },

    // For post awards - reference to the post
    targetPost: {
      type: Schema.Types.ObjectId,
      ref: "ImagePost",
    },

    // The user receiving the award (post owner or direct user award)
    targetUser: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    // Custom message explaining the award
    message: {
      type: String,
      required: true,
      maxlength: 500,
      default: "This content has exceptional engagement!",
    },

    // Award amount in INR
    amount: {
      type: Number,
      min: 0,
      default: 0,
    },

    // Award status
    status: {
      type: String,
      enum: ["pending", "approved", "paid", "rejected"],
      default: "pending",
    },

    // Whether to show this award in public feeds
    showInFeed: {
      type: Boolean,
      default: true,
    },

    // Priority for ordering in feeds (higher = shown first)
    priority: {
      type: Number,
      default: 0,
    },

    // Admin who created the award
    awardedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    // When payment was made
    paidAt: {
      type: Date,
    },

    // User's payment method at time of award
    paymentMethod: {
      type: {
        type: String,
        enum: ["upi", "phone"],
      },
      value: String,
    },
  },
  { timestamps: true }
);

// Indexes for efficient queries
awardSchema.index({ type: 1, status: 1, createdAt: -1 });
awardSchema.index({ targetUser: 1, status: 1 });
awardSchema.index({ targetPost: 1 });
awardSchema.index({ showInFeed: 1, priority: -1, createdAt: -1 });
awardSchema.index({ awardedBy: 1, createdAt: -1 });

export const Award = mongoose.model<IAward>("Award", awardSchema);
