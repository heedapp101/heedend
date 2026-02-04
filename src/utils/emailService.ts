import nodemailer from "nodemailer";
import EmailConfig, { IEmailConfig, IEmailRecipient } from "../models/EmailConfig.js";
import ErrorLog, { IErrorLog, ErrorSeverity, ErrorSource } from "../models/ErrorLog.js";

// Default configuration (will be overridden by DB config)
// ⚠️ SECURITY: All sensitive values loaded from environment variables
const DEFAULT_CONFIG = {
  smtpHost: process.env.SMTP_HOST || "smtp.gmail.com",
  smtpPort: parseInt(process.env.SMTP_PORT || "587"),
  smtpSecure: process.env.SMTP_SECURE === "true",
  smtpUser: process.env.SMTP_USER || "",
  smtpPass: process.env.SMTP_PASS || "",
  fromEmail: process.env.SMTP_FROM_EMAIL || "",
  fromName: process.env.SMTP_FROM_NAME || "HEED Error Monitor",
};

// Severity colors for email
const SEVERITY_COLORS: Record<ErrorSeverity, string> = {
  critical: "#DC2626",
  high: "#EA580C",
  medium: "#CA8A04",
  low: "#2563EB",
};

const SEVERITY_EMOJI: Record<ErrorSeverity, string> = {
  critical: "🚨",
  high: "⚠️",
  medium: "⚡",
  low: "ℹ️",
};

// Get or create email configuration
export const getEmailConfig = async (): Promise<IEmailConfig> => {
  let config = await EmailConfig.findOne();
  
  if (!config) {
    // Create default config
    config = new EmailConfig({
      ...DEFAULT_CONFIG,
      recipients: [
        {
          email: "heedltd@gmail.com",
          name: "HEED Admin",
          active: true,
          notifyOn: ["critical", "high"],
          sources: ["all"],
        },
      ],
      enabled: true,
    });
    await config.save();
  }
  
  return config;
};

// Create transporter
const createTransporter = async () => {
  const config = await getEmailConfig();
  
  return nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpSecure,
    auth: {
      user: config.smtpUser,
      pass: config.smtpPass,
    },
  });
};

// Check if we should send email for this error
const shouldSendEmail = async (
  config: IEmailConfig,
  severity: ErrorSeverity,
  source: ErrorSource,
  errorCode: string
): Promise<{ shouldSend: boolean; recipients: string[] }> => {
  if (!config.enabled) {
    return { shouldSend: false, recipients: [] };
  }
  
  // Check rate limiting
  const now = new Date();
  if (now > config.hourResetAt) {
    config.emailsSentThisHour = 0;
    config.hourResetAt = new Date(now.getTime() + 60 * 60 * 1000);
    await config.save();
  }
  
  if (config.emailsSentThisHour >= config.maxEmailsPerHour) {
    console.log("Email rate limit reached");
    return { shouldSend: false, recipients: [] };
  }
  
  // Check cooldown for same error
  const lastSent = config.lastSentErrors.get(errorCode);
  if (lastSent) {
    const cooldownMs = config.cooldownMinutes * 60 * 1000;
    if (now.getTime() - lastSent.getTime() < cooldownMs) {
      console.log(`Error ${errorCode} is in cooldown`);
      return { shouldSend: false, recipients: [] };
    }
  }
  
  // Get eligible recipients
  const eligibleRecipients = config.recipients.filter((r) => {
    if (!r.active) return false;
    if (!r.notifyOn.includes(severity)) return false;
    if (!r.sources.includes("all") && !r.sources.includes(source as any)) return false;
    return true;
  });
  
  if (eligibleRecipients.length === 0) {
    return { shouldSend: false, recipients: [] };
  }
  
  return {
    shouldSend: true,
    recipients: eligibleRecipients.map((r) => r.email),
  };
};

// Generate error email HTML
const generateErrorEmailHtml = (error: IErrorLog): string => {
  const severityColor = SEVERITY_COLORS[error.severity];
  const emoji = SEVERITY_EMOJI[error.severity];
  
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>HEED Error Alert</title>
</head>
<body style="margin: 0; padding: 0; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f3f4f6;">
  <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
    <!-- Header -->
    <div style="background-color: ${severityColor}; padding: 20px; border-radius: 8px 8px 0 0;">
      <h1 style="color: white; margin: 0; font-size: 24px;">
        ${emoji} HEED Error Alert
      </h1>
      <p style="color: rgba(255,255,255,0.9); margin: 8px 0 0 0; font-size: 14px;">
        ${error.severity.toUpperCase()} severity error detected
      </p>
    </div>
    
    <!-- Content -->
    <div style="background-color: white; padding: 24px; border-radius: 0 0 8px 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
      <!-- Error Summary -->
      <div style="margin-bottom: 24px;">
        <h2 style="color: #1f2937; margin: 0 0 12px 0; font-size: 18px;">Error Details</h2>
        <table style="width: 100%; border-collapse: collapse;">
          <tr>
            <td style="padding: 8px 0; color: #6b7280; font-size: 14px; width: 120px;">Error Code:</td>
            <td style="padding: 8px 0; color: #1f2937; font-size: 14px; font-weight: 600;">${error.errorCode}</td>
          </tr>
          <tr>
            <td style="padding: 8px 0; color: #6b7280; font-size: 14px;">Source:</td>
            <td style="padding: 8px 0; color: #1f2937; font-size: 14px;">
              <span style="background-color: #e5e7eb; padding: 2px 8px; border-radius: 4px; font-size: 12px;">
                ${error.source.toUpperCase()}
              </span>
            </td>
          </tr>
          <tr>
            <td style="padding: 8px 0; color: #6b7280; font-size: 14px;">Endpoint:</td>
            <td style="padding: 8px 0; color: #1f2937; font-size: 14px;">${error.method || "N/A"} ${error.endpoint || "N/A"}</td>
          </tr>
          <tr>
            <td style="padding: 8px 0; color: #6b7280; font-size: 14px;">Status Code:</td>
            <td style="padding: 8px 0; color: #1f2937; font-size: 14px;">${error.statusCode || "N/A"}</td>
          </tr>
          <tr>
            <td style="padding: 8px 0; color: #6b7280; font-size: 14px;">Occurred At:</td>
            <td style="padding: 8px 0; color: #1f2937; font-size: 14px;">${new Date(error.occurredAt).toLocaleString()}</td>
          </tr>
        </table>
      </div>
      
      <!-- Error Message -->
      <div style="margin-bottom: 24px;">
        <h3 style="color: #1f2937; margin: 0 0 8px 0; font-size: 16px;">Message</h3>
        <div style="background-color: #fef2f2; border-left: 4px solid ${severityColor}; padding: 12px; border-radius: 4px;">
          <p style="margin: 0; color: #991b1b; font-size: 14px; font-family: monospace; word-break: break-word;">
            ${error.message}
          </p>
        </div>
      </div>
      
      <!-- Stack Trace (if available) -->
      ${error.stack ? `
      <div style="margin-bottom: 24px;">
        <h3 style="color: #1f2937; margin: 0 0 8px 0; font-size: 16px;">Stack Trace</h3>
        <div style="background-color: #1f2937; padding: 12px; border-radius: 4px; overflow-x: auto;">
          <pre style="margin: 0; color: #e5e7eb; font-size: 11px; white-space: pre-wrap; word-break: break-all;">
${error.stack.substring(0, 1000)}${error.stack.length > 1000 ? "\n... (truncated)" : ""}
          </pre>
        </div>
      </div>
      ` : ""}
      
      <!-- Context Info -->
      <div style="margin-bottom: 24px;">
        <h3 style="color: #1f2937; margin: 0 0 8px 0; font-size: 16px;">Context</h3>
        <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
          <tr>
            <td style="padding: 6px 0; color: #6b7280;">User ID:</td>
            <td style="padding: 6px 0; color: #1f2937;">${error.userId || "Anonymous"}</td>
          </tr>
          <tr>
            <td style="padding: 6px 0; color: #6b7280;">Client IP:</td>
            <td style="padding: 6px 0; color: #1f2937;">${error.clientIp || "Unknown"}</td>
          </tr>
          <tr>
            <td style="padding: 6px 0; color: #6b7280;">Environment:</td>
            <td style="padding: 6px 0; color: #1f2937;">${error.environment}</td>
          </tr>
        </table>
      </div>
      
      <!-- Action Button -->
      <div style="text-align: center; margin-top: 24px;">
        <a href="${process.env.ADMIN_URL || "http://localhost:5173"}/admin/compliance" 
           style="display: inline-block; background-color: #3b82f6; color: white; padding: 12px 24px; 
                  border-radius: 6px; text-decoration: none; font-weight: 600; font-size: 14px;">
          View in Dashboard
        </a>
      </div>
    </div>
    
    <!-- Footer -->
    <div style="text-align: center; padding: 20px; color: #9ca3af; font-size: 12px;">
      <p style="margin: 0;">HEED Error Monitoring System</p>
      <p style="margin: 4px 0 0 0;">This is an automated message. Do not reply.</p>
    </div>
  </div>
</body>
</html>
  `;
};

// Send error notification email
export const sendErrorEmail = async (error: IErrorLog): Promise<boolean> => {
  try {
    const config = await getEmailConfig();
    
    const { shouldSend, recipients } = await shouldSendEmail(
      config,
      error.severity,
      error.source,
      error.errorCode
    );
    
    if (!shouldSend || recipients.length === 0) {
      return false;
    }
    
    const transporter = await createTransporter();
    
    const mailOptions = {
      from: `"${config.fromName}" <${config.fromEmail}>`,
      to: recipients.join(", "),
      subject: `${SEVERITY_EMOJI[error.severity]} [${error.severity.toUpperCase()}] ${error.source}: ${error.message.substring(0, 50)}...`,
      html: generateErrorEmailHtml(error),
    };
    
    await transporter.sendMail(mailOptions);
    
    // Update rate limiting
    config.emailsSentThisHour += 1;
    config.lastSentErrors.set(error.errorCode, new Date());
    await config.save();
    
    // Update error log
    error.emailSent = true;
    error.emailSentAt = new Date();
    error.emailRecipients = recipients;
    await error.save();
    
    console.log(`Error email sent to ${recipients.join(", ")}`);
    return true;
  } catch (err) {
    console.error("Failed to send error email:", err);
    return false;
  }
};

// Send test email
export const sendTestEmail = async (toEmail: string): Promise<{ success: boolean; message: string }> => {
  try {
    const config = await getEmailConfig();
    const transporter = await createTransporter();
    
    await transporter.sendMail({
      from: `"${config.fromName}" <${config.fromEmail}>`,
      to: toEmail,
      subject: "✅ HEED Error Monitor - Test Email",
      html: `
        <div style="font-family: Arial, sans-serif; padding: 20px; max-width: 500px; margin: 0 auto;">
          <h2 style="color: #22c55e;">✅ Test Email Successful!</h2>
          <p>Your HEED error monitoring email configuration is working correctly.</p>
          <p style="color: #6b7280; font-size: 14px;">Sent at: ${new Date().toLocaleString()}</p>
        </div>
      `,
    });
    
    config.lastTestedAt = new Date();
    config.lastTestStatus = "success";
    await config.save();
    
    return { success: true, message: "Test email sent successfully" };
  } catch (err: any) {
    const config = await getEmailConfig();
    config.lastTestedAt = new Date();
    config.lastTestStatus = `failed: ${err.message}`;
    await config.save();
    
    return { success: false, message: err.message };
  }
};

// Log and optionally email an error
export const logError = async (
  errorData: Partial<IErrorLog> & { message: string; source: ErrorSource }
): Promise<IErrorLog> => {
  // Generate error code if not provided
  const errorCode = errorData.errorCode || 
    `${errorData.source.toUpperCase()}_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
  
  // Determine severity based on status code or explicit setting
  let severity: ErrorSeverity = errorData.severity || "medium";
  if (!errorData.severity && errorData.statusCode) {
    if (errorData.statusCode >= 500) severity = "high";
    else if (errorData.statusCode >= 400) severity = "medium";
  }
  
  // Create error log
  const errorLog = new ErrorLog({
    ...errorData,
    errorCode,
    severity,
    occurredAt: new Date(),
  });
  
  await errorLog.save();
  
  // Send email for high/critical errors
  if (severity === "critical" || severity === "high") {
    await sendErrorEmail(errorLog);
  }
  
  return errorLog;
};

export default {
  getEmailConfig,
  sendErrorEmail,
  sendTestEmail,
  logError,
};
