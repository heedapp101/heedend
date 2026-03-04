import mongoose, { Schema, Document, Types } from "mongoose";

export type OfferApplicationStatus = "pending" | "approved" | "rejected";

export interface IOfferEligibilitySnapshot {
  eligible: boolean;
  totalSpent: number;
  requiredAmount: number;
  matchingOrders: number;
  month: number;
  year: number;
  lastCheckedAt: Date;
}

export interface IOfferApplication extends Document {
  offer: Types.ObjectId;
  user: Types.ObjectId;
  name: string;
  phone?: string;
  note?: string;
  status: OfferApplicationStatus;
  adminMessage?: string;
  reviewedBy?: Types.ObjectId;
  reviewedAt?: Date;
  eligibilitySnapshot: IOfferEligibilitySnapshot;
  createdAt: Date;
  updatedAt: Date;
}

const offerEligibilitySnapshotSchema = new Schema<IOfferEligibilitySnapshot>(
  {
    eligible: { type: Boolean, required: true, default: false },
    totalSpent: { type: Number, required: true, default: 0, min: 0 },
    requiredAmount: { type: Number, required: true, default: 0, min: 0 },
    matchingOrders: { type: Number, required: true, default: 0, min: 0 },
    month: { type: Number, required: true, min: 1, max: 12 },
    year: { type: Number, required: true, min: 2020, max: 2100 },
    lastCheckedAt: { type: Date, required: true, default: Date.now },
  },
  { _id: false }
);

const offerApplicationSchema = new Schema<IOfferApplication>(
  {
    offer: { type: Schema.Types.ObjectId, ref: "Offer", required: true, index: true },
    user: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    phone: { type: String, trim: true, maxlength: 20 },
    note: { type: String, trim: true, maxlength: 1000 },
    status: {
      type: String,
      enum: ["pending", "approved", "rejected"],
      default: "pending",
      index: true,
    },
    adminMessage: { type: String, trim: true, maxlength: 1000 },
    reviewedBy: { type: Schema.Types.ObjectId, ref: "User" },
    reviewedAt: { type: Date },
    eligibilitySnapshot: {
      type: offerEligibilitySnapshotSchema,
      required: true,
    },
  },
  { timestamps: true }
);

offerApplicationSchema.index({ offer: 1, user: 1 }, { unique: true });
offerApplicationSchema.index({ offer: 1, status: 1, createdAt: -1 });
offerApplicationSchema.index({ user: 1, createdAt: -1 });

export default mongoose.model<IOfferApplication>("OfferApplication", offerApplicationSchema);
