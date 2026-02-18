import { Schema, Document, model, Types } from "mongoose";

export interface IEmailRecipient {
  email: string;
  name: string;
  active: boolean;
  notifyOn: ("critical" | "high" | "medium" | "low")[];
  sources: ("mongodb" | "cloudflare" | "google-vision" | "gemini-vision" | "feature" | "auth" | "payment" | "socket" | "api" | "system" | "all")[];
  addedAt: Date;
}

export interface IEmailConfig extends Document {
  // SMTP Configuration
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser: string;
  smtpPass: string; // Encrypted in production
  
  // Email Settings
  fromEmail: string;
  fromName: string;
  
  // Recipients
  recipients: IEmailRecipient[];
  
  // Notification Settings
  enabled: boolean;
  batchErrors: boolean; // If true, batch multiple errors into one email
  batchIntervalMinutes: number; // How often to send batched emails
  
  // Rate limiting
  maxEmailsPerHour: number;
  emailsSentThisHour: number;
  hourResetAt: Date;
  
  // Cooldown settings (to avoid spam)
  cooldownMinutes: number; // Don't send same error type within this period
  lastSentErrors: Map<string, Date>; // errorCode -> lastSent
  
  // Metadata
  lastTestedAt?: Date;
  lastTestStatus?: string;
  createdAt: Date;
  updatedAt: Date;
}

const emailRecipientSchema = new Schema<IEmailRecipient>({
  email: { type: String, required: true },
  name: { type: String, required: true },
  active: { type: Boolean, default: true },
  notifyOn: [{
    type: String,
    enum: ["critical", "high", "medium", "low"],
    default: ["critical", "high"],
  }],
  sources: [{
    type: String,
    enum: ["mongodb", "cloudflare", "google-vision", "gemini-vision", "feature", "auth", "payment", "socket", "api", "system", "all"],
    default: ["all"],
  }],
  addedAt: { type: Date, default: Date.now },
});

const emailConfigSchema = new Schema<IEmailConfig>(
  {
    smtpHost: { type: String, default: "smtp.gmail.com" },
    smtpPort: { type: Number, default: 587 },
    smtpSecure: { type: Boolean, default: false },
    smtpUser: { type: String, required: true },
    smtpPass: { type: String, required: true },
    
    fromEmail: { type: String, required: true },
    fromName: { type: String, default: "HEED Error Monitor" },
    
    recipients: [emailRecipientSchema],
    
    enabled: { type: Boolean, default: true },
    batchErrors: { type: Boolean, default: false },
    batchIntervalMinutes: { type: Number, default: 15 },
    
    maxEmailsPerHour: { type: Number, default: 20 },
    emailsSentThisHour: { type: Number, default: 0 },
    hourResetAt: { type: Date, default: Date.now },
    
    cooldownMinutes: { type: Number, default: 30 },
    lastSentErrors: { type: Map, of: Date, default: new Map() },
    
    lastTestedAt: { type: Date },
    lastTestStatus: { type: String },
  },
  { timestamps: true }
);

// Ensure only one config document exists
emailConfigSchema.index({ createdAt: 1 }, { unique: true });

export default model<IEmailConfig>("EmailConfig", emailConfigSchema);
