import { Schema, model, Types, Document } from "mongoose";

export interface IFollow extends Document {
  follower: Types.ObjectId;
  following: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const followSchema = new Schema<IFollow>(
  {
    follower: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    following: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
  },
  { timestamps: true }
);

followSchema.index({ follower: 1, following: 1 }, { unique: true });
followSchema.index({ following: 1, createdAt: -1 });
followSchema.index({ follower: 1, createdAt: -1 });

export default model<IFollow>("Follow", followSchema);
