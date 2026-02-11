import { Schema, model, Document } from "mongoose";

export interface IOrderCounter extends Document {
  date: string; // YYYYMMDD
  seq: number;
}

const orderCounterSchema = new Schema<IOrderCounter>(
  {
    date: { type: String, required: true, unique: true },
    seq: { type: Number, default: 0 },
  },
  { timestamps: true }
);

orderCounterSchema.index({ date: 1 }, { unique: true });

export default model<IOrderCounter>("OrderCounter", orderCounterSchema);
