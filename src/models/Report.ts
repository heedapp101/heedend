import mongoose, { Schema, Document, Types } from "mongoose";

export interface IReport extends Document {
  post: Types.ObjectId;
  reporter: Types.ObjectId;
  reason: 
    | "stolen_content" 
    | "inappropriate" 
    | "spam" 
    | "misleading" 
    | "harassment" 
    | "other";
  customReason?: string;
  status: "pending" | "reviewed" | "dismissed" | "action_taken";
  adminNotes?: string;
  reviewedBy?: Types.ObjectId;
  reviewedAt?: Date;
  createdAt: Date;
}

const ReportSchema = new Schema<IReport>(
  {
    post: { type: Schema.Types.ObjectId, ref: "ImagePost", required: true },
    reporter: { type: Schema.Types.ObjectId, ref: "User", required: true },
    reason: {
      type: String,
      enum: ["stolen_content", "inappropriate", "spam", "misleading", "harassment", "other"],
      required: true,
    },
    customReason: { type: String, maxlength: 500 },
    status: {
      type: String,
      enum: ["pending", "reviewed", "dismissed", "action_taken"],
      default: "pending",
    },
    adminNotes: { type: String },
    reviewedBy: { type: Schema.Types.ObjectId, ref: "User" },
    reviewedAt: { type: Date },
  },
  { timestamps: true }
);

// Index for efficient queries
ReportSchema.index({ status: 1, createdAt: -1 });
ReportSchema.index({ post: 1, reporter: 1 }, { unique: true }); // One report per user per post

export default mongoose.model<IReport>("Report", ReportSchema);
