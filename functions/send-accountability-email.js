const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = "accountability@trycleanguard.com";

exports.handler = async (event) => {
  // Only allow POST
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: "Method not allowed" })
    };
  }

  try {
    const { to, userName, streakDays } = JSON.parse(event.body);

    if (!to || !userName) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Missing email or name" })
      };
    }

    // Validate email format
    if (!to.includes("@")) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Invalid email" })
      };
    }

    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to: to,
        subject: "📊 CleanGuard Check-In — Keep Your Streak Going!",
        html: `
          <div style="font-family: 'DM Sans', Arial, sans-serif; color: #f1f5f9; max-width: 500px; background: #0a0a0f; padding: 40px 20px; border-radius: 12px;">
            <h2 style="color: #22c55e; margin-top: 0;">Hey ${userName}! 👋</h2>
            
            <p style="color: #94a3b8; line-height: 1.6;">
              Just checking in on your CleanGuard journey. You've been making amazing progress!
            </p>
            
            <div style="background: linear-gradient(135deg, #22c55e 0%, #16a34a 100%); color: white; padding: 30px; border-radius: 8px; text-align: center; margin: 30px 0;">
              <div style="font-size: 48px; font-weight: bold; margin-bottom: 8px;">${streakDays || 0}</div>
              <div style="font-size: 16px;">days of progress 🔥</div>
            </div>
            
            <p style="color: #94a3b8; line-height: 1.6;">
              You're building incredible strength and resilience. Every day counts. Keep pushing forward!
            </p>
            
            <div style="background: rgba(34, 197, 94, 0.1); border-left: 3px solid #22c55e; padding: 15px; margin: 20px 0; border-radius: 4px;">
              <p style="margin: 0; color: #86efac; font-size: 14px;">
                💪 Your accountability partner believes in you.
              </p>
            </div>
            
            <p style="color: #64748b; font-size: 13px; margin-top: 30px;">
              This email was sent because you enabled Accountability Partner in CleanGuard.
              <br>
              <a href="https://trycleanguard.com" style="color: #22c55e; text-decoration: none;">Learn more about CleanGuard</a>
            </p>
          </div>
        `
      })
    });

    if (!response.ok) {
      const error = await response.json();
      console.error("Resend error:", error);
      return {
        statusCode: response.status,
        body: JSON.stringify({ error: error.message || "Failed to send email" })
      };
    }

    const result = await response.json();
    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, messageId: result.id })
    };
  } catch (error) {
    console.error("Email handler error:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message })
    };
  }
};
