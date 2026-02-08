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
  
  // Verification & Store
  idProofType?: 'GST' | 'PAN' | 'Aadhaar' | 'Driving License'; // One of these is mandatory
  idProofNumber?: string; // ✅ The ID number
  idProofUrl?: string;  // ✅ URL to the uploaded doc
  productType?: string; // ✅ New
  
  // Business Delivery Options
  cashOnDeliveryAvailable?: boolean;
  allIndiaDelivery?: boolean;
  freeShipping?: boolean;
  returnPolicy?: string; // e.g., '7 days', '15 days', 'No returns'
  
  // --- Social Features ---
  followers: mongoose.Types.ObjectId[];
  following: mongoose.Types.ObjectId[];
  
  // --- Push Notifications ---
  pushTokens: {
    token: string;
    platform: 'ios' | 'android' | 'unknown';
    createdAt: Date;
  }[];
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
    
    // Identity Proof (One of: GST, PAN, Aadhaar, Driving License)
    idProofType: { 
      type: String, 
      enum: ['GST', 'PAN', 'Aadhaar', 'Driving License'],
      trim: true 
    },
    idProofNumber: { type: String, trim: true },
    idProofUrl: { type: String, trim: true },
    
    // Store Settings
    productType: { type: String, trim: true },
    
    // Business Delivery Options
    cashOnDeliveryAvailable: { type: Boolean, default: false },
    allIndiaDelivery: { type: Boolean, default: false },
    freeShipping: { type: Boolean, default: false },
    returnPolicy: { type: String, trim: true, default: '' },
    
    // --- Social Features ---
    followers: [{ type: Schema.Types.ObjectId, ref: "User" }],
    following: [{ type: Schema.Types.ObjectId, ref: "User" }],
    
    // --- Push Notifications ---
    pushTokens: [{
      token: { type: String, required: true },
      platform: { type: String, enum: ['ios', 'android', 'unknown'], default: 'unknown' },
      createdAt: { type: Date, default: Date.now },
    }],
  },
  { timestamps: true }
);

// Indexes for faster search and lookup
userSchema.index({ username: 1 });
userSchema.index({ name: 1 });
userSchema.index({ companyName: 1 });
userSchema.index(
  { username: "text", name: "text", companyName: "text", bio: "text" },
  {
    weights: { username: 10, companyName: 6, name: 4, bio: 1 },
    name: "user_text_index",
  }
);

// ✅ Updated Business Validation Hook
userSchema.pre("save", function (next) {
  if (this.userType === "business") {
    // Ensure they provided an ID Proof (one of: GST, PAN, Aadhaar, Driving License)
    if (!this.idProofType || !this.idProofNumber || !this.idProofUrl) {
      return next(new Error("Business accounts require a valid ID proof (GST, PAN, Aadhaar, or Driving License) with number and document upload."));
    }
  }
  next();
});

export default model<IUser>("User", userSchema);
