import mongoose, { Schema, Document } from "mongoose";

export interface IComment extends Document {
  post: mongoose.Types.ObjectId;
  user: mongoose.Types.ObjectId;
  text: string;
  parentId: mongoose.Types.ObjectId | null;
  likes: mongoose.Types.ObjectId[];
  createdAt: Date;
}

const commentSchema = new Schema<IComment>(
  {
    post: { type: Schema.Types.ObjectId, ref: "ImagePost", required: true },
    user: { type: Schema.Types.ObjectId, ref: "User", required: true },
    text: { type: String, required: true, trim: true },
    parentId: { type: Schema.Types.ObjectId, ref: "Comment", default: null }, // For nested replies
    likes: [{ type: Schema.Types.ObjectId, ref: "User" }], // Array of User IDs who liked
  },
  { timestamps: true }
);

export default mongoose.model<IComment>("Comment", commentSchema);