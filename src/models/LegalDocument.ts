import { Schema, Document, model } from "mongoose";

export interface ILegalDocument extends Document {
  title: string;
  slug: string;
  content: string;
  version: number;
  isActive: boolean;
  isRequired: boolean;
  publishedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const legalDocumentSchema = new Schema<ILegalDocument>(
  {
    title: { type: String, required: true, trim: true },
    slug: { type: String, required: true, trim: true, lowercase: true, unique: true },
    content: { type: String, required: true },
    version: { type: Number, default: 1, min: 1 },
    isActive: { type: Boolean, default: true },
    isRequired: { type: Boolean, default: true },
    publishedAt: { type: Date },
  },
  { timestamps: true }
);

legalDocumentSchema.index({ slug: 1 }, { unique: true });
legalDocumentSchema.index({ isActive: 1, isRequired: 1 });

export default model<ILegalDocument>("LegalDocument", legalDocumentSchema);
