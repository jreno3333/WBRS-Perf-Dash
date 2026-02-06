import { Resend } from "resend";

let resendInstance: Resend | null = null;

function getResend(): Resend | null {
  if (!resendInstance) {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      console.warn("[email] RESEND_API_KEY not configured - emails will not be sent");
      return null;
    }
    resendInstance = new Resend(apiKey);
  }
  return resendInstance;
}

const FROM_EMAIL = process.env.RESEND_FROM_EMAIL || "MWB Dashboard <onboarding@resend.dev>";

export async function sendMagicLinkEmail(to: string, magicLink: string): Promise<boolean> {
  try {
    const resend = getResend();
    if (!resend) {
      console.warn("[email] Resend not configured, magic link:", magicLink);
      return false;
    }

    const { error } = await resend.emails.send({
      from: FROM_EMAIL,
      to,
      subject: "Sign in to MWB Dashboard",
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
          <h2 style="color: #1a1a1a; margin-bottom: 24px;">Sign in to MWB Dashboard</h2>
          <p style="color: #4a4a4a; font-size: 16px; line-height: 1.5; margin-bottom: 32px;">
            Click the button below to sign in. This link expires in 15 minutes.
          </p>
          <a href="${magicLink}" 
             style="display: inline-block; background-color: #2563eb; color: white; padding: 12px 32px; 
                    border-radius: 6px; text-decoration: none; font-weight: 500; font-size: 16px;">
            Sign In
          </a>
          <p style="color: #9a9a9a; font-size: 13px; margin-top: 32px; line-height: 1.5;">
            If you didn't request this, you can safely ignore this email.
          </p>
        </div>
      `,
    });

    if (error) {
      console.error("[email] Failed to send magic link:", error);
      return false;
    }
    return true;
  } catch (err) {
    console.error("[email] Error sending magic link:", err);
    return false;
  }
}

export async function sendDailyReportEmail(
  to: string,
  subject: string,
  htmlContent: string
): Promise<boolean> {
  try {
    const resend = getResend();
    if (!resend) {
      console.warn("[email] Resend not configured, skipping daily report to:", to);
      return false;
    }

    const { error } = await resend.emails.send({
      from: FROM_EMAIL,
      to,
      subject,
      html: htmlContent,
    });

    if (error) {
      console.error("[email] Failed to send daily report:", error);
      return false;
    }
    return true;
  } catch (err) {
    console.error("[email] Error sending daily report:", err);
    return false;
  }
}
