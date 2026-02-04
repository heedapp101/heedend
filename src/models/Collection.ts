import mongoose, { Schema, Document } from "mongoose";

export interface ICollection extends Document {
  user: Schema.Types.ObjectId;
  name: string;
  isPrivate: boolean;
  posts: Schema.Types.ObjectId[];
}

const collectionSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true },
    name: { type: String, required: true, trim: true },
    isPrivate: { type: Boolean, default: false },
    posts: [{ type: Schema.Types.ObjectId, ref: "ImagePost" }],
  },
  { timestamps: true }
);

export default mongoose.model<ICollection>("Collection", collectionSchema);