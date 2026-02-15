import mongoose, { Schema, Document, Types } from "mongoose";

export interface IUserReport extends Document {
  reportedUser: Types.ObjectId;
  reporter: Types.ObjectId;
  reason:
    | "spam"
    | "harassment"
    | "inappropriate"
    | "impersonation"
    | "scam"
    | "other";
  customReason?: string;
  status: "pending" | "reviewed" | "dismissed" | "action_taken";
  adminNotes?: string;
  reviewedBy?: Types.ObjectId;
  reviewedAt?: Date;
  createdAt: Date;
}

const UserReportSchema = new Schema<IUserReport>(
  {
    reportedUser: { type: Schema.Types.ObjectId, ref: "User", required: true },
    reporter: { type: Schema.Types.ObjectId, ref: "User", required: true },
    reason: {
      type: String,
      enum: ["spam", "harassment", "inappropriate", "impersonation", "scam", "other"],
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

UserReportSchema.index({ status: 1, createdAt: -1 });
UserReportSchema.index({ reportedUser: 1, reporter: 1 }, { unique: true });

export default mongoose.model<IUserReport>("UserReport", UserReportSchema);
