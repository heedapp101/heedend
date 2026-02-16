import twilio from "twilio";

// ==========================================
// TWILIO SMS SERVICE
// ==========================================
// Required env vars:
//   TWILIO_ACCOUNT_SID  - from Twilio Console
//   TWILIO_AUTH_TOKEN    - from Twilio Console
//   TWILIO_PHONE_NUMBER  - your Twilio phone number (e.g. +1234567890)
// ==========================================

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const twilioPhone = process.env.TWILIO_PHONE_NUMBER;

// Only create client if credentials are available
let client: twilio.Twilio | null = null;

if (accountSid && authToken) {
  client = twilio(accountSid, authToken);
  console.log("✅ Twilio SMS service initialized");
} else {
  console.warn("⚠️  Twilio credentials not set — SMS will be logged to console only");
}

/**
 * Send an SMS message via Twilio.
 * Falls back to console.log if Twilio is not configured.
 */
export const sendSMS = async (to: string, body: string): Promise<boolean> => {
  // If Twilio is configured, send real SMS
  if (client && twilioPhone) {
    try {
      const message = await client.messages.create({
        body,
        from: twilioPhone,
        to,
      });
      console.log(`📱 [SMS] Sent to ${to} | SID: ${message.sid}`);
      return true;
    } catch (error: any) {
      console.error(`❌ [SMS] Failed to send to ${to}:`, error.message);
      // Fall through to console logging in dev
      if (process.env.NODE_ENV === "production") {
        throw new Error("Failed to send SMS. Please try again.");
      }
    }
  }

  // Fallback: log to console (development)
  console.log(`📱 [SMS-DEV] To ${to}: ${body}`);
  return true;
};

/**
 * Send OTP via SMS
 */
export const sendOtpSMS = async (phone: string, otp: string): Promise<boolean> => {
  const message = `Your Heeszo verification code is: ${otp}. Valid for 5 minutes. Do not share this code.`;
  return sendSMS(phone, message);
};

export default { sendSMS, sendOtpSMS };
