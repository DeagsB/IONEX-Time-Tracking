# Supabase SMTP Email Configuration & Troubleshooting

## Common Issues with Custom SMTP in Supabase

If you've configured custom SMTP in Supabase but aren't receiving emails, follow these troubleshooting steps:

## 0. Enable Email Signups (IMPORTANT!)

**If you see the error "Email signups are disabled":**

1. Go to **Supabase Dashboard** → **Authentication** → **Providers**
2. Find **"Email"** in the list of providers
3. Click to expand the Email provider settings
4. **Enable** the Email provider (toggle it ON)
5. Save the changes

This is required before email/password authentication will work!

## 1. Verify SMTP Configuration in Supabase Dashboard

1. Go to **Supabase Dashboard** → **Settings** → **Auth** → **SMTP Settings**
2. Verify all fields are correctly filled:
   - **SMTP Host**: Your email provider's SMTP server (e.g., `smtp.gmail.com`, `smtp.office365.com`)
   - **SMTP Port**: Usually `587` for TLS or `465` for SSL
   - **SMTP User**: Your full email address
   - **SMTP Password**: Your email password or app-specific password
   - **Sender Email**: The email address that will appear as the sender
   - **Sender Name**: Display name for emails

## 2. Common SMTP Provider Settings

### Gmail
- **Host**: `smtp.gmail.com`
- **Port**: `587` (TLS) or `465` (SSL)
- **User**: Your full Gmail address
- **Password**: Use an [App Password](https://support.google.com/accounts/answer/185833) (not your regular password)
- **Enable**: "Less secure app access" is deprecated, use App Passwords instead

### Microsoft 365 / Outlook
- **Host**: `smtp.office365.com`
- **Port**: `587` (TLS)
- **User**: Your full email address
- **Password**: Your email password
- **Note**: May require MFA to be configured

### SendGrid
- **Host**: `smtp.sendgrid.net`
- **Port**: `587` (TLS)
- **User**: `apikey`
- **Password**: Your SendGrid API key

### Mailgun
- **Host**: `smtp.mailgun.org`
- **Port**: `587` (TLS)
- **User**: Your Mailgun SMTP username
- **Password**: Your Mailgun SMTP password

## 3. Check Email Confirmation Settings

1. Go to **Supabase Dashboard** → **Authentication** → **Settings**
2. Verify **"Enable email confirmations"** is enabled
3. Check **"Secure email change"** if you want email changes to require confirmation

## 4. Verify Email Templates

1. Go to **Supabase Dashboard** → **Authentication** → **Email Templates**
2. Check that templates are configured:
   - **Confirm signup** - Sent when user signs up
   - **Magic Link** - Sent for passwordless login
   - **Change Email Address** - Sent when email is changed
   - **Reset Password** - Sent for password reset

3. Verify the **Redirect URL** in templates matches your app:
   - Should be: `https://your-app.vercel.app/auth/callback` (or your domain)
   - Or: `https://your-project.supabase.co/auth/v1/callback` for testing

## 5. Check Supabase Logs

1. Go to **Supabase Dashboard** → **Logs** → **Auth Logs**
2. Look for email-related errors:
   - SMTP connection failures
   - Authentication errors
   - Email sending failures

## 6. Test SMTP Connection

### Option A: Use Supabase's Test Email Feature
1. Go to **Settings** → **Auth** → **SMTP Settings**
2. Click **"Send test email"** if available
3. Check for any error messages

### Option B: Check Email Provider Logs
- Check your email provider's sent items folder
- Check spam/junk folder
- Review email provider's activity logs for blocked attempts

## 7. Common Issues & Solutions

### Issue: "SMTP authentication failed"
**Solution:**
- Verify username and password are correct
- For Gmail, ensure you're using an App Password, not your regular password
- Check if 2FA/MFA is enabled and requires special handling

### Issue: "Connection timeout"
**Solution:**
- Verify SMTP host and port are correct
- Check firewall settings
- Try different ports (587 vs 465)

### Issue: "Emails sent but not received"
**Solution:**
- Check spam/junk folder
- Verify sender email address is not blocked
- Check email provider's rate limits
- Verify recipient email address is correct

### Issue: "Emails not appearing in sent folder"
**Solution:**
- Supabase sends emails through your SMTP server, so they should appear in your sent folder
- If not appearing, check:
  - SMTP server settings
  - Whether your email provider supports "sent items" tracking for SMTP
  - Some providers don't show SMTP-sent emails in sent folder

## 8. Verify Redirect URLs

1. Go to **Supabase Dashboard** → **Authentication** → **URL Configuration**
2. Ensure your app URLs are in **Redirect URLs**:
   - `https://your-app.vercel.app`
   - `https://your-app.vercel.app/**`
   - `http://localhost:5173` (for local development)

## 9. Check Rate Limits

- Some email providers have rate limits
- Free tiers may have daily sending limits
- Check your email provider's documentation

## 10. Alternative: Use Supabase's Built-in Email Service

If custom SMTP continues to have issues:

1. Go to **Settings** → **Auth** → **SMTP Settings**
2. Disable custom SMTP
3. Use Supabase's default email service (limited on free tier)
4. Upgrade to Pro plan for better email delivery

## 11. Debug in Application Code

Add logging to check if signup is being called correctly:

```typescript
// In AuthContext.tsx, signUp function
const { data, error } = await supabase.auth.signUp({
  email,
  password,
  options: {
    emailRedirectTo: `${window.location.origin}/auth/callback`,
    data: {
      first_name: firstName,
      last_name: lastName,
    },
  },
});

console.log('Signup result:', { data, error });
console.log('Email confirmation needed:', !data.session && !!data.user);
```

## 12. Verify Email Address

- Ensure the email address you're testing with is valid
- Try a different email address to rule out provider-specific issues
- Check if the email domain has any special restrictions

## Still Not Working?

1. **Check Supabase Status**: Visit https://status.supabase.com
2. **Review Documentation**: https://supabase.com/docs/guides/auth/auth-smtp
3. **Contact Support**: Supabase support or your email provider support
4. **Try Different Email Provider**: Test with a different SMTP provider to isolate the issue

