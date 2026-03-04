import mongoose, { Schema, Document, Types } from "mongoose";

export interface IOffer extends Document {
  title: string;
  subtitle?: string;
  message: string;
  bannerImageUrl?: string;
  brandLabel: string;
  ctaLabel: string;
  minPurchaseAmount: number;
  eligibilityMonth: number; // 1-12
  eligibilityYear: number; // YYYY
  startDate: Date;
  endDate: Date;
  isActive: boolean;
  priority: number;
  createdBy: Types.ObjectId;
  updatedBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const offerSchema = new Schema<IOffer>(
  {
    title: { type: String, required: true, trim: true, maxlength: 120 },
    subtitle: { type: String, trim: true, maxlength: 180 },
    message: { type: String, required: true, trim: true, maxlength: 1200 },
    bannerImageUrl: { type: String, trim: true },
    brandLabel: { type: String, trim: true, default: "Heeszo", maxlength: 40 },
    ctaLabel: { type: String, trim: true, default: "Participate", maxlength: 30 },
    minPurchaseAmount: { type: Number, required: true, min: 0 },
    eligibilityMonth: { type: Number, required: true, min: 1, max: 12 },
    eligibilityYear: { type: Number, required: true, min: 2020, max: 2100 },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    isActive: { type: Boolean, default: true, index: true },
    priority: { type: Number, default: 999, min: 1 },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

offerSchema.index({ isActive: 1, startDate: 1, endDate: 1, priority: 1, createdAt: -1 });
offerSchema.index({ eligibilityYear: 1, eligibilityMonth: 1, priority: 1 });

export default mongoose.model<IOffer>("Offer", offerSchema);
