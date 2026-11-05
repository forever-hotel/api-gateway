function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!
  );
}

function emailLayout(title: string, content: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0;padding:24px 12px;background:#f5f3ef;font-family:Arial,Helvetica,sans-serif;color:#1a1a18;line-height:1.6"><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;border:1px solid #ddd8cf;border-radius:12px;overflow:hidden;background:#ffffff"><tr><td style="padding:24px 28px;background:#12263a;color:#ffffff"><div style="font-size:20px;font-weight:700">Forever Hotel</div><div style="font-size:12px;color:#e8eef4;letter-spacing:2px">STAFF ACCOUNTS</div></td></tr><tr><td style="height:4px;background:#c9920d"></td></tr><tr><td style="padding:28px"><h1 style="margin:0 0 16px;font-size:24px;line-height:1.3;color:#1a3c5e">${title}</h1>${content}</td></tr><tr><td style="padding:20px 28px;border-top:1px solid #ddd8cf;color:#5a5650;font-size:12px">Forever Hotel &middot; Account security<br>This is an automated message. For assistance, contact your hotel administrator.</td></tr></table></td></tr></table></body></html>`;
}

export function passwordResetEmail(code: string) {
  return {
    subject: 'Your Forever Hotel password reset code',
    textContent: `Reset your Forever Hotel password\n\nYour password reset code is ${code}.\n\nEnter this code on the password reset page, then choose a new password.\nThe code expires in 10 minutes and can be used only once. Your new password must differ from your current password.\n\nResetting your password signs out your existing sessions across staff systems. Sign in again using your new password.\n\nIf you did not request this, ignore this email. Your password will remain unchanged. Never share this code; hotel staff will never ask you to send it to them.\n\nForever Hotel | Account security`,
    htmlContent: emailLayout(
      'Reset your password',
      `<p>We received a request to reset your Forever Hotel staff password.</p><p>Enter the verification code below on the password reset page:</p><div style="margin:24px 0;padding:22px 12px;text-align:center;background:#e8eef4;border:1px solid #ddd8cf;border-radius:8px"><div style="font-size:12px;color:#5a5650;margin-bottom:8px">YOUR VERIFICATION CODE</div><div style="font-family:monospace;font-size:34px;font-weight:700;letter-spacing:8px;color:#1a3c5e">${escapeHtml(code)}</div><div style="font-size:13px;color:#5a5650;margin-top:8px">Expires in 10 minutes &middot; Single use</div></div><p>Choose a new password that differs from your current password. After resetting, sign in again with your new password. Existing sessions across your staff systems will be signed out.</p><p style="padding:14px;background:#fdf6e3;border-left:3px solid #c9920d;font-size:13px"><strong>Didn&rsquo;t request this?</strong> You can ignore this email. Your password will remain unchanged.</p><p style="font-size:13px;color:#5a5650">Never share this code. Hotel staff will never ask you to send it to them.</p>`
    )
  };
}
