import { Schema, Document, model, Types } from "mongoose";
import mongoose from "mongoose";

// ✅ Interest Interface for Weighted Frequency Algorithm
interface IInterest {
  tag: string;
  score: number;
  lastInteracted: Date;
}

export interface IUser extends Document {
  // --- Common Mandatory Fields ---
  userType: "general" | "business" | "admin";
  username: string;
  name: string;
  email: string;
  password: string;
  phone: string;
  isVerified: boolean;
  googleId?: string; // ✅ For Google Sign In
  usernameLower?: string;
  nameLower?: string;
  companyNameLower?: string;
  emailLower?: string;

  // --- Common Optional Fields ---
  bio?: string;
  profilePic?: string; // ✅ New
  bannerImg?: string;  // ✅ New
  location?: string;   // ✅ New
  showLocation?: boolean; // ✅ Privacy: Display location on profile
  interests: IInterest[]; // ✅ Updated: Weighted Interest System

  // --- General User Specific ---
  age?: number;
  gender?: "Male" | "Female" | "Other";

  // --- Business User Specific ---
  companyName?: string;
  country?: string;    // ✅ New
  address?: string;
  gstNumber?: string;  // ✅ Renamed from GST
  requireChatBeforePurchase?: boolean;
  autoReplyEnabled?: boolean;
  autoReplyMessage?: string;
  customQuickQuestion?: string;
  inventoryAlertThreshold?: number;
  
  // Verification & Store
  idProofType?: 'GST' | 'Driving License' | 'PAN' | 'Aadhaar'; // PAN/Aadhaar kept as legacy values
  idProofNumber?: string; // ✅ The ID number
  idProofUrl?: string;  // ✅ URL to the uploaded doc
  productType?: string; // ✅ New
  
  // Business Delivery Options
  cashOnDeliveryAvailable?: boolean;
  allIndiaDelivery?: boolean;
  freeShipping?: boolean;
  returnPolicy?: string; // e.g., '7 days', '15 days', 'No returns'

  // --- Seller Payment Details ---
  paymentDetails?: {
    upiId?: string;
    accountHolderName?: string;
    accountNumber?: string;
    ifsc?: string;
    bankName?: string;
    phone?: string;
    note?: string;
  };
  
  // --- Social Features ---
  followersCount: number;
  followingCount: number;
  
  // --- Push Notifications ---
  pushTokens: {
    token: string;
    platform: 'ios' | 'android' | 'unknown';
    createdAt: Date;
  }[];

  // --- Legal Acceptance ---
  legalAcceptances: {
    docId: Types.ObjectId;
    version: number;
    acceptedAt: Date;
  }[];

  // --- Award Payment Method (for receiving awards) ---
  awardPaymentMethod?: {
    type: 'upi' | 'phone';
    value: string;
  };

  // --- User Awards (direct user awards, not post awards) ---
  isAwarded?: boolean;
  userAwardMessage?: string;
  userAwardAmount?: number;
  userAwardStatus?: 'pending' | 'approved' | 'paid' | 'rejected';
  userAwardedAt?: Date;
  userAwardShowInFeed?: boolean;

  // --- Deletion ---
  isDeleted: boolean;
  deletedAt?: Date;
  deletedReason?: string;
  deletedBy?: "user" | "admin" | "system";
  
  // --- Timestamps (auto-added by Mongoose) ---
  createdAt: Date;
  updatedAt: Date;
}

const userSchema = new Schema<IUser>(
  {
    userType: {
      type: String,
      enum: ["general", "business", "admin"],
      required: true,
    },
    // ✅ Logic: Business users start unverified
    isVerified: {
      type: Boolean,
      default: function (this: IUser) {
        return this.userType !== "business";
      },
    },
    username: { type: String, required: true, unique: true, lowercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    usernameLower: { type: String, trim: true, lowercase: true, index: true },
    nameLower: { type: String, trim: true, lowercase: true, index: true },
    companyNameLower: { type: String, trim: true, lowercase: true, index: true },
    emailLower: { type: String, trim: true, lowercase: true, index: true },
    password: { type: String, required: true },
    phone: { type: String, required: true },
    googleId: { type: String, sparse: true, index: true }, // ✅ For Google Sign In

    // --- Profile Assets ---
    bio: { type: String, trim: true },
    profilePic: { type: String, default: "" },
    bannerImg: { type: String, default: "" },
    location: { type: String, trim: true },
    showLocation: { type: Boolean, default: true }, // Show location on profile by default
    // ✅ Weighted Interest System with Time Decay
    interests: [
      {
        tag: { type: String, required: true, trim: true, lowercase: true },
        score: { type: Number, default: 0 },
        lastInteracted: { type: Date, default: Date.now },
      },
    ],

    // --- General Specific ---
    age: Number,
    gender: { type: String, enum: ["Male", "Female", "Other"] },

    // --- Business Specific ---
    companyName: {
      type: String,
      trim: true,
      required: function (this: IUser) { return this.userType === "business"; },
    },
    country: { type: String, trim: true },
    address: { type: String, trim: true },
    gstNumber: { type: String, trim: true }, // Optional, not all businesses have GST immediately
    
    // Identity Proof (GST and Driving License are active; PAN/Aadhaar are legacy)
    idProofType: { 
      type: String, 
      enum: ['GST', 'Driving License', 'PAN', 'Aadhaar'],
      trim: true 
    },
    idProofNumber: { type: String, trim: true },
    idProofUrl: { type: String, trim: true },
    
    // Store Settings
    productType: { type: String, trim: true },
    requireChatBeforePurchase: { type: Boolean, default: true },
    autoReplyEnabled: { type: Boolean, default: true },
    autoReplyMessage: {
      type: String,
      trim: true,
      default: "Thanks for your message. We will reply soon.",
    },
    customQuickQuestion: { type: String, trim: true, default: "" },
    inventoryAlertThreshold: { type: Number, min: 1, default: 3 },
    
    // Business Delivery Options
    cashOnDeliveryAvailable: { type: Boolean, default: false },
    allIndiaDelivery: { type: Boolean, default: false },
    freeShipping: { type: Boolean, default: false },
    returnPolicy: { type: String, trim: true, default: '' },

    // Seller Payment Details (shared with buyers at checkout)
    paymentDetails: {
      upiId: { type: String, trim: true, default: "" },
      accountHolderName: { type: String, trim: true, default: "" },
      accountNumber: { type: String, trim: true, default: "" },
      ifsc: { type: String, trim: true, default: "" },
      bankName: { type: String, trim: true, default: "" },
      phone: { type: String, trim: true, default: "" },
      note: { type: String, trim: true, default: "" },
    },

    // Award Payment Method (for receiving award payments)
    awardPaymentMethod: {
      type: { type: String, enum: ['upi', 'phone'] },
      value: { type: String, trim: true },
    },

    // User Awards (direct user awards)
    isAwarded: { type: Boolean, default: false },
    userAwardMessage: { type: String, trim: true, maxlength: 500 },
    userAwardAmount: { type: Number, min: 0 },
    userAwardStatus: {
      type: String,
      enum: ['pending', 'approved', 'paid', 'rejected'],
      default: 'pending',
    },
    userAwardedAt: { type: Date },
    userAwardShowInFeed: { type: Boolean, default: true },
    
    // --- Social Features (denormalized counts) ---
    followersCount: { type: Number, default: 0 },
    followingCount: { type: Number, default: 0 },
    
    // --- Push Notifications ---
    pushTokens: [{
      token: { type: String, required: true },
      platform: { type: String, enum: ['ios', 'android', 'unknown'], default: 'unknown' },
      createdAt: { type: Date, default: Date.now },
    }],

    // --- Legal Acceptances ---
    legalAcceptances: [{
      docId: { type: Schema.Types.ObjectId, ref: "LegalDocument", required: true },
      version: { type: Number, required: true, min: 1 },
      acceptedAt: { type: Date, default: Date.now },
    }],

    // --- Deletion Flags ---
    isDeleted: { type: Boolean, default: false, index: true },
    deletedAt: { type: Date },
    deletedReason: { type: String, trim: true },
    deletedBy: { type: String, enum: ["user", "admin", "system"] },
  },
  { timestamps: true }
);

// Indexes for faster search and lookup
userSchema.index({ username: 1 });
userSchema.index({ name: 1 });
userSchema.index({ companyName: 1 });
userSchema.index({ usernameLower: 1 });
userSchema.index({ nameLower: 1 });
userSchema.index({ companyNameLower: 1 });
userSchema.index({ emailLower: 1 });
userSchema.index(
  { username: "text", name: "text", companyName: "text", bio: "text" },
  {
    weights: { username: 10, companyName: 6, name: 4, bio: 1 },
    name: "user_text_index",
  }
);

// ✅ Updated Business Validation Hook
userSchema.pre("save", function (next) {
  this.usernameLower = this.username ? this.username.toLowerCase() : this.usernameLower;
  this.nameLower = this.name ? this.name.toLowerCase() : this.nameLower;
  this.companyNameLower = this.companyName ? this.companyName.toLowerCase() : this.companyNameLower;
  this.emailLower = this.email ? this.email.toLowerCase() : this.emailLower;

  if (this.userType === "business") {
    // Ensure they provided an ID Proof
    if (!this.idProofType || !this.idProofNumber || !this.idProofUrl) {
      return next(new Error("Business accounts require a valid ID proof with number and document upload."));
    }
  }
  next();
});

export default model<IUser>("User", userSchema);
