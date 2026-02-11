import { Schema, model, Types, Document } from "mongoose";

export interface IPostView extends Document {
  post: Types.ObjectId;
  user: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const postViewSchema = new Schema<IPostView>(
  {
    post: { type: Schema.Types.ObjectId, ref: "ImagePost", required: true, index: true },
    user: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
  },
  { timestamps: true }
);

postViewSchema.index({ post: 1, user: 1 }, { unique: true });
postViewSchema.index({ user: 1, createdAt: -1 });

export default model<IPostView>("PostView", postViewSchema);
