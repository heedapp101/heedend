import mongoose, { Schema, Document } from "mongoose";

export interface ISavedAddress extends Document {
  user: mongoose.Types.ObjectId;
  label: string; // e.g. "Home", "Office", "Other"
  fullName: string;
  phone: string;
  addressLine1: string;
  addressLine2?: string;
  city: string;
  state: string;
  pincode: string;
  landmark?: string;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const savedAddressSchema = new Schema<ISavedAddress>(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    label: {
      type: String,
      trim: true,
      default: "Home",
      maxlength: 30,
    },
    fullName: { type: String, required: true, trim: true },
    phone: { type: String, required: true, trim: true },
    addressLine1: { type: String, required: true, trim: true },
    addressLine2: { type: String, trim: true, default: "" },
    city: { type: String, required: true, trim: true },
    state: { type: String, required: true, trim: true },
    pincode: { type: String, required: true, trim: true },
    landmark: { type: String, trim: true, default: "" },
    isDefault: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// Limit to max 5 addresses per user (enforced at controller level)
// Ensure only one default per user
savedAddressSchema.pre("save", async function (next) {
  if (this.isDefault) {
    await mongoose.model("SavedAddress").updateMany(
      { user: this.user, _id: { $ne: this._id } },
      { isDefault: false }
    );
  }
  next();
});

export default mongoose.model<ISavedAddress>("SavedAddress", savedAddressSchema);
