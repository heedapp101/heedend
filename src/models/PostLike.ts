import { Schema, model, Types, Document } from "mongoose";

export interface IPostLike extends Document {
  post: Types.ObjectId;
  user: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const postLikeSchema = new Schema<IPostLike>(
  {
    post: { type: Schema.Types.ObjectId, ref: "ImagePost", required: true, index: true },
    user: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
  },
  { timestamps: true }
);

postLikeSchema.index({ post: 1, user: 1 }, { unique: true });
postLikeSchema.index({ user: 1, createdAt: -1 });

export default model<IPostLike>("PostLike", postLikeSchema);
