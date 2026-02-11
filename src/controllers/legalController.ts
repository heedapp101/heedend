import { Request, Response } from "express";
import LegalDocument from "../models/LegalDocument.js";
import User from "../models/User.js";
import { AuthRequest } from "../middleware/authMiddleware.js";

const toSlug = (value: string) =>
  value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)+/g, "");

export const getRequiredLegalDocs = async (_req: Request, res: Response) => {
  try {
    const docs = await LegalDocument.find({ isActive: true, isRequired: true })
      .sort({ updatedAt: -1 })
      .select("title slug content version updatedAt publishedAt isRequired isActive");
    res.status(200).json({ docs });
  } catch (error: any) {
    res.status(500).json({ message: error.message });
  }
};

export const getLegalDocBySlug = async (req: Request, res: Response) => {
  try {
    const slug = String(req.params.slug || "").toLowerCase().trim();
    if (!slug) return res.status(400).json({ message: "Slug is required" });

    const doc = await LegalDocument.findOne({ slug, isActive: true });
    if (!doc) return res.status(404).json({ message: "Document not found" });

    res.status(200).json(doc);
  } catch (error: any) {
    res.status(500).json({ message: error.message });
  }
};

export const getPendingLegalDocs = async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) return res.status(401).json({ message: "Unauthorized" });

    const user = await User.findById(req.user._id).select("legalAcceptances isDeleted");
    if (!user || user.isDeleted) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const docs = await LegalDocument.find({ isActive: true, isRequired: true })
      .sort({ updatedAt: -1 })
      .select("title slug content version updatedAt publishedAt isRequired isActive");

    const acceptedMap = new Map<string, number>();
    (user.legalAcceptances || []).forEach((acc: any) => {
      acceptedMap.set(String(acc.docId), acc.version);
    });

    const pending = docs.filter((doc) => {
      const acceptedVersion = acceptedMap.get(String(doc._id)) || 0;
      return acceptedVersion < doc.version;
    });

    res.status(200).json({
      pending,
      totalRequired: docs.length,
    });
  } catch (error: any) {
    res.status(500).json({ message: error.message });
  }
};

export const acceptLegalDocs = async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) return res.status(401).json({ message: "Unauthorized" });

    const { acceptances, acceptAllRequired } = req.body as {
      acceptances?: Array<{ docId: string; version?: number }>;
      acceptAllRequired?: boolean;
    };

    let targetDocs: Array<{ docId: string; version: number }> = [];

    if (acceptAllRequired) {
      const docs = await LegalDocument.find({ isActive: true, isRequired: true })
        .select("_id version");
      targetDocs = docs.map((doc) => ({
        docId: String(doc._id),
        version: doc.version,
      }));
    } else if (Array.isArray(acceptances) && acceptances.length > 0) {
      targetDocs = acceptances
        .filter((a) => a.docId)
        .map((a) => ({
          docId: String(a.docId),
          version: Number(a.version || 0),
        }));
    }

    if (targetDocs.length === 0) {
      return res.status(400).json({ message: "No documents provided for acceptance" });
    }

    const user = await User.findById(req.user._id);
    if (!user || user.isDeleted) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const docs = await LegalDocument.find({
      _id: { $in: targetDocs.map((d) => d.docId) },
      isActive: true,
    }).select("_id version isRequired");

    const docMap = new Map<string, number>();
    docs.forEach((doc) => docMap.set(String(doc._id), doc.version));

    const now = new Date();
    const updated = user.legalAcceptances ? [...user.legalAcceptances] : [];

    targetDocs.forEach((entry) => {
      const currentVersion = docMap.get(String(entry.docId));
      if (!currentVersion) return;

      const existing = updated.find((a: any) => String(a.docId) === String(entry.docId));
      if (!existing) {
        updated.push({
          docId: entry.docId as any,
          version: currentVersion,
          acceptedAt: now,
        });
      } else if (existing.version < currentVersion) {
        existing.version = currentVersion;
        existing.acceptedAt = now;
      }
    });

    user.legalAcceptances = updated as any;
    await user.save();

    res.status(200).json({ success: true, acceptedAt: now });
  } catch (error: any) {
    res.status(500).json({ message: error.message });
  }
};

// =========================
// Admin Endpoints
// =========================
export const listLegalDocs = async (_req: Request, res: Response) => {
  try {
    const docs = await LegalDocument.find().sort({ updatedAt: -1 });
    res.status(200).json({ docs });
  } catch (error: any) {
    res.status(500).json({ message: error.message });
  }
};

export const createLegalDoc = async (req: Request, res: Response) => {
  try {
    const { title, slug, content, isActive = true, isRequired = true } = req.body as {
      title: string;
      slug?: string;
      content: string;
      isActive?: boolean;
      isRequired?: boolean;
    };

    if (!title || !content) {
      return res.status(400).json({ message: "Title and content are required" });
    }

    const finalSlug = slug ? toSlug(slug) : toSlug(title);
    if (!finalSlug) {
      return res.status(400).json({ message: "Invalid slug" });
    }

    const existing = await LegalDocument.findOne({ slug: finalSlug });
    if (existing) {
      return res.status(400).json({ message: "Slug already exists" });
    }

    const doc = await LegalDocument.create({
      title: title.trim(),
      slug: finalSlug,
      content,
      version: 1,
      isActive: !!isActive,
      isRequired: !!isRequired,
      publishedAt: isActive ? new Date() : undefined,
    });

    res.status(201).json({ doc });
  } catch (error: any) {
    res.status(500).json({ message: error.message });
  }
};

export const updateLegalDoc = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { title, slug, content, isActive, isRequired, bumpVersion } = req.body as {
      title?: string;
      slug?: string;
      content?: string;
      isActive?: boolean;
      isRequired?: boolean;
      bumpVersion?: boolean;
    };

    const doc = await LegalDocument.findById(id);
    if (!doc) return res.status(404).json({ message: "Document not found" });

    if (title) doc.title = title.trim();
    if (slug) doc.slug = toSlug(slug);
    if (content) doc.content = content;
    if (typeof isActive === "boolean") doc.isActive = isActive;
    if (typeof isRequired === "boolean") doc.isRequired = isRequired;

    if (bumpVersion) {
      doc.version = Math.max(1, (doc.version || 1) + 1);
      doc.publishedAt = new Date();
    }

    await doc.save();

    res.status(200).json({ doc });
  } catch (error: any) {
    res.status(500).json({ message: error.message });
  }
};

export const toggleLegalDoc = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { isActive, isRequired } = req.body as {
      isActive?: boolean;
      isRequired?: boolean;
    };

    const update: any = {};
    if (typeof isActive === "boolean") update.isActive = isActive;
    if (typeof isRequired === "boolean") update.isRequired = isRequired;

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ message: "No fields to update" });
    }

    const doc = await LegalDocument.findByIdAndUpdate(id, update, { new: true });
    if (!doc) return res.status(404).json({ message: "Document not found" });

    res.status(200).json({ doc });
  } catch (error: any) {
    res.status(500).json({ message: error.message });
  }
};
