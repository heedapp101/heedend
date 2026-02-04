import { Request, Response } from "express";
import ErrorLog, { ErrorSeverity, ErrorSource, IErrorLog } from "../models/ErrorLog.js";
import EmailConfig from "../models/EmailConfig.js";
import { getEmailConfig, sendTestEmail, logError } from "../utils/emailService.js";
import mongoose, { Types } from "mongoose";

interface AuthRequest extends Request {
  user?: { _id: Types.ObjectId; userType?: string };
}

// ==================== ERROR LOGS ====================

/**
 * Get all error logs with filtering and pagination
 * GET /api/compliance/errors
 */
export const getErrorLogs = async (req: AuthRequest, res: Response) => {
  try {
    const {
      page = 1,
      limit = 50,
      severity,
      source,
      resolved,
      startDate,
      endDate,
      search,
    } = req.query;

    const query: any = {};

    if (severity) query.severity = severity;
    if (source) query.source = source;
    if (resolved !== undefined) query.resolved = resolved === "true";
    
    if (startDate || endDate) {
      query.occurredAt = {};
      if (startDate) query.occurredAt.$gte = new Date(startDate as string);
      if (endDate) query.occurredAt.$lte = new Date(endDate as string);
    }
    
    if (search) {
      query.$or = [
        { message: { $regex: search, $options: "i" } },
        { errorCode: { $regex: search, $options: "i" } },
        { endpoint: { $regex: search, $options: "i" } },
      ];
    }

    const skip = (Number(page) - 1) * Number(limit);

    const [errors, total, stats] = await Promise.all([
      ErrorLog.find(query)
        .sort({ occurredAt: -1 })
        .skip(skip)
        .limit(Number(limit))
        .populate("userId", "username email")
        .populate("resolvedBy", "username"),
      ErrorLog.countDocuments(query),
      // Get stats
      ErrorLog.aggregate([
        {
          $facet: {
            bySeverity: [
              { $group: { _id: "$severity", count: { $sum: 1 } } },
            ],
            bySource: [
              { $group: { _id: "$source", count: { $sum: 1 } } },
            ],
            byResolved: [
              { $group: { _id: "$resolved", count: { $sum: 1 } } },
            ],
            recent24h: [
              { $match: { occurredAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } } },
              { $count: "count" },
            ],
            recent7d: [
              { $match: { occurredAt: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } } },
              { $count: "count" },
            ],
          },
        },
      ]),
    ]);

    // Format stats
    const statsData = stats[0];
    const formattedStats = {
      bySeverity: Object.fromEntries(statsData.bySeverity.map((s: any) => [s._id, s.count])),
      bySource: Object.fromEntries(statsData.bySource.map((s: any) => [s._id, s.count])),
      resolved: statsData.byResolved.find((s: any) => s._id === true)?.count || 0,
      unresolved: statsData.byResolved.find((s: any) => s._id === false)?.count || 0,
      last24h: statsData.recent24h[0]?.count || 0,
      last7d: statsData.recent7d[0]?.count || 0,
      total,
    };

    res.json({
      errors,
      stats: formattedStats,
      pagination: {
        page: Number(page),
        limit: Number(limit),
        total,
        pages: Math.ceil(total / Number(limit)),
      },
    });
  } catch (error: any) {
    console.error("Get error logs error:", error);
    res.status(500).json({ message: "Failed to fetch error logs", error: error.message });
  }
};

/**
 * Get single error log
 * GET /api/compliance/errors/:errorId
 */
export const getErrorById = async (req: AuthRequest, res: Response) => {
  try {
    const { errorId } = req.params;

    const error = await ErrorLog.findById(errorId)
      .populate("userId", "username email name")
      .populate("resolvedBy", "username name");

    if (!error) {
      return res.status(404).json({ message: "Error log not found" });
    }

    res.json(error);
  } catch (error: any) {
    console.error("Get error by ID error:", error);
    res.status(500).json({ message: "Failed to fetch error", error: error.message });
  }
};

/**
 * Resolve/unresolve an error
 * PATCH /api/compliance/errors/:errorId/resolve
 */
export const resolveError = async (req: AuthRequest, res: Response) => {
  try {
    const { errorId } = req.params;
    const { resolved, notes } = req.body;
    const userId = req.user?._id;

    const error = await ErrorLog.findById(errorId);
    if (!error) {
      return res.status(404).json({ message: "Error log not found" });
    }

    error.resolved = resolved;
    if (resolved) {
      error.resolvedAt = new Date();
      error.resolvedBy = userId;
      error.resolutionNotes = notes;
    } else {
      error.resolvedAt = undefined;
      error.resolvedBy = undefined;
      error.resolutionNotes = undefined;
    }

    await error.save();

    res.json({ message: `Error ${resolved ? "resolved" : "reopened"}`, error });
  } catch (error: any) {
    console.error("Resolve error error:", error);
    res.status(500).json({ message: "Failed to update error", error: error.message });
  }
};

/**
 * Delete error logs (bulk or single)
 * DELETE /api/compliance/errors
 */
export const deleteErrors = async (req: AuthRequest, res: Response) => {
  try {
    const { ids, deleteAll, deleteResolved } = req.body;

    let result;
    if (deleteAll) {
      result = await ErrorLog.deleteMany({});
    } else if (deleteResolved) {
      result = await ErrorLog.deleteMany({ resolved: true });
    } else if (ids && ids.length > 0) {
      result = await ErrorLog.deleteMany({ _id: { $in: ids } });
    } else {
      return res.status(400).json({ message: "No deletion criteria provided" });
    }

    res.json({ message: `Deleted ${result.deletedCount} error logs` });
  } catch (error: any) {
    console.error("Delete errors error:", error);
    res.status(500).json({ message: "Failed to delete errors", error: error.message });
  }
};

/**
 * Get error statistics/analytics
 * GET /api/compliance/stats
 */
export const getErrorStats = async (req: AuthRequest, res: Response) => {
  try {
    const { days = 7 } = req.query;
    const startDate = new Date(Date.now() - Number(days) * 24 * 60 * 60 * 1000);

    const stats = await ErrorLog.aggregate([
      { $match: { occurredAt: { $gte: startDate } } },
      {
        $facet: {
          // Errors by day
          byDay: [
            {
              $group: {
                _id: { $dateToString: { format: "%Y-%m-%d", date: "$occurredAt" } },
                count: { $sum: 1 },
                critical: { $sum: { $cond: [{ $eq: ["$severity", "critical"] }, 1, 0] } },
                high: { $sum: { $cond: [{ $eq: ["$severity", "high"] }, 1, 0] } },
              },
            },
            { $sort: { _id: 1 } },
          ],
          // Top error sources
          topSources: [
            { $group: { _id: "$source", count: { $sum: 1 } } },
            { $sort: { count: -1 } },
            { $limit: 5 },
          ],
          // Top endpoints with errors
          topEndpoints: [
            { $match: { endpoint: { $exists: true, $ne: null } } },
            { $group: { _id: "$endpoint", count: { $sum: 1 } } },
            { $sort: { count: -1 } },
            { $limit: 10 },
          ],
          // Most common errors
          topErrors: [
            { $group: { _id: "$message", count: { $sum: 1 }, severity: { $first: "$severity" } } },
            { $sort: { count: -1 } },
            { $limit: 10 },
          ],
          // Resolution rate
          resolutionRate: [
            {
              $group: {
                _id: null,
                total: { $sum: 1 },
                resolved: { $sum: { $cond: ["$resolved", 1, 0] } },
              },
            },
          ],
        },
      },
    ]);

    const data = stats[0];
    const resolutionData = data.resolutionRate[0] || { total: 0, resolved: 0 };

    res.json({
      byDay: data.byDay,
      topSources: data.topSources,
      topEndpoints: data.topEndpoints,
      topErrors: data.topErrors,
      resolutionRate: resolutionData.total > 0 
        ? Math.round((resolutionData.resolved / resolutionData.total) * 100) 
        : 0,
      period: `${days} days`,
    });
  } catch (error: any) {
    console.error("Get error stats error:", error);
    res.status(500).json({ message: "Failed to fetch stats", error: error.message });
  }
};

// ==================== EMAIL CONFIGURATION ====================

/**
 * Get email configuration
 * GET /api/compliance/email-config
 */
export const getEmailConfiguration = async (req: AuthRequest, res: Response) => {
  try {
    const config = await getEmailConfig();
    
    // Don't send password
    const safeConfig = {
      ...config.toObject(),
      smtpPass: "••••••••••••",
    };

    res.json(safeConfig);
  } catch (error: any) {
    console.error("Get email config error:", error);
    res.status(500).json({ message: "Failed to fetch email config", error: error.message });
  }
};

/**
 * Update email configuration
 * PUT /api/compliance/email-config
 */
export const updateEmailConfiguration = async (req: AuthRequest, res: Response) => {
  try {
    const updates = req.body;
    
    let config = await EmailConfig.findOne();
    if (!config) {
      config = new EmailConfig(updates);
    } else {
      // Don't update password if it's the masked value
      if (updates.smtpPass === "••••••••••••") {
        delete updates.smtpPass;
      }
      Object.assign(config, updates);
    }

    await config.save();

    res.json({ message: "Email configuration updated", config: { ...config.toObject(), smtpPass: "••••••••••••" } });
  } catch (error: any) {
    console.error("Update email config error:", error);
    res.status(500).json({ message: "Failed to update email config", error: error.message });
  }
};

/**
 * Add email recipient
 * POST /api/compliance/email-config/recipients
 */
export const addEmailRecipient = async (req: AuthRequest, res: Response) => {
  try {
    const { email, name, notifyOn, sources } = req.body;

    if (!email || !name) {
      return res.status(400).json({ message: "Email and name are required" });
    }

    const config = await getEmailConfig();

    // Check if recipient already exists
    const exists = config.recipients.some((r) => r.email === email);
    if (exists) {
      return res.status(400).json({ message: "Recipient already exists" });
    }

    config.recipients.push({
      email,
      name,
      active: true,
      notifyOn: notifyOn || ["critical", "high"],
      sources: sources || ["all"],
      addedAt: new Date(),
    });

    await config.save();

    res.json({ message: "Recipient added", recipients: config.recipients });
  } catch (error: any) {
    console.error("Add recipient error:", error);
    res.status(500).json({ message: "Failed to add recipient", error: error.message });
  }
};

/**
 * Update email recipient
 * PATCH /api/compliance/email-config/recipients/:email
 */
export const updateEmailRecipient = async (req: AuthRequest, res: Response) => {
  try {
    const { email } = req.params;
    const updates = req.body;

    const config = await getEmailConfig();

    const recipientIndex = config.recipients.findIndex((r) => r.email === email);
    if (recipientIndex === -1) {
      return res.status(404).json({ message: "Recipient not found" });
    }

    Object.assign(config.recipients[recipientIndex], updates);
    await config.save();

    res.json({ message: "Recipient updated", recipients: config.recipients });
  } catch (error: any) {
    console.error("Update recipient error:", error);
    res.status(500).json({ message: "Failed to update recipient", error: error.message });
  }
};

/**
 * Remove email recipient
 * DELETE /api/compliance/email-config/recipients/:email
 */
export const removeEmailRecipient = async (req: AuthRequest, res: Response) => {
  try {
    const { email } = req.params;

    const config = await getEmailConfig();

    config.recipients = config.recipients.filter((r) => r.email !== email);
    await config.save();

    res.json({ message: "Recipient removed", recipients: config.recipients });
  } catch (error: any) {
    console.error("Remove recipient error:", error);
    res.status(500).json({ message: "Failed to remove recipient", error: error.message });
  }
};

/**
 * Send test email
 * POST /api/compliance/email-config/test
 */
export const testEmailConfiguration = async (req: AuthRequest, res: Response) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ message: "Email address is required" });
    }

    const result = await sendTestEmail(email);

    if (result.success) {
      res.json({ message: result.message });
    } else {
      res.status(500).json({ message: result.message });
    }
  } catch (error: any) {
    console.error("Test email error:", error);
    res.status(500).json({ message: "Failed to send test email", error: error.message });
  }
};

/**
 * Manually log an error (for testing)
 * POST /api/compliance/errors/manual
 */
export const manualLogError = async (req: AuthRequest, res: Response) => {
  try {
    const { message, source, severity, metadata } = req.body;

    if (!message || !source) {
      return res.status(400).json({ message: "Message and source are required" });
    }

    const error = await logError({
      message,
      source,
      severity: severity || "medium",
      metadata,
      endpoint: "/api/compliance/errors/manual",
      method: "POST",
    });

    res.json({ message: "Error logged", error });
  } catch (error: any) {
    console.error("Manual log error:", error);
    res.status(500).json({ message: "Failed to log error", error: error.message });
  }
};
