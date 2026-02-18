import mongoose, { Schema, Document } from "mongoose";

/* =============================================
   AD MODEL: For In-Feed Ads and Banner Ads
   Supports admin-created advertisements
============================================= */

export interface IAd extends Document {
  // Basic Info
  title: string;
  description?: string;
  imageUrl: string;
  linkUrl?: string; // Optional
  
  // Ad Type
  type: "in-feed" | "banner";
  priority: number;
  
  // Scheduling
  startDate: Date;
  endDate: Date;
  isActive: boolean;
  
  // Payment Info
  payment: {
    amount: number;
    currency: string;
    method: string;
    status: "pending" | "paid" | "refunded";
    transactionId?: string;
  };
  
  // Advertiser Info
  advertiser: {
    name: string;
    email: string;
    company?: string;
    phone?: string;
  };
  
  // Analytics
  impressions: number;
  clicks: number;
  
  // Timestamps
  createdAt: Date;
  updatedAt: Date;
}

const adSchema = new Schema<IAd>(
  {
    // Basic Info
    title: { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    imageUrl: { type: String, required: true },
    linkUrl: { type: String, trim: true }, // Optional - ad may not have external link
    
    // Ad Type: "in-feed" for posts between content, "banner" for top banners
    type: { 
      type: String, 
      enum: ["in-feed", "banner"], 
      required: true,
      default: "in-feed"
    },
    priority: { type: Number, default: 999, min: 1 },
    
    // Scheduling
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    isActive: { type: Boolean, default: true },
    
    // Payment Details
    payment: {
      amount: { type: Number, required: true, min: 0 },
      currency: { type: String, default: "INR" },
      method: { type: String, default: "manual" }, // manual, upi, card, etc.
      status: { 
        type: String, 
        enum: ["pending", "paid", "refunded"],
        default: "pending"
      },
      transactionId: { type: String, trim: true },
    },
    
    // Advertiser Contact
    advertiser: {
      name: { type: String, required: true, trim: true },
      email: { type: String, required: true, trim: true, lowercase: true },
      company: { type: String, trim: true },
      phone: { type: String, trim: true },
    },
    
    // Analytics
    impressions: { type: Number, default: 0 },
    clicks: { type: Number, default: 0 },
  },
  { timestamps: true }
);

// Indexes for efficient querying
adSchema.index({ type: 1, isActive: 1 }); // Filter active ads by type
adSchema.index({ type: 1, priority: 1, createdAt: 1 }); // Priority ordering for display
adSchema.index({ startDate: 1, endDate: 1 }); // Date range queries
adSchema.index({ "payment.status": 1 }); // Payment filtering
adSchema.index({ createdAt: -1 }); // Recent ads

// Virtual: Check if ad is currently running
adSchema.virtual("isRunning").get(function () {
  const now = new Date();
  return this.isActive && now >= this.startDate && now <= this.endDate;
});

// Virtual: Click-through rate
adSchema.virtual("ctr").get(function () {
  if (this.impressions === 0) return 0;
  return ((this.clicks / this.impressions) * 100).toFixed(2);
});

export default mongoose.model<IAd>("Ad", adSchema);
