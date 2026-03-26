# How to Update the Confirm Signup Email Template in Supabase

## Steps to Update the Email Template

1. **Log into Supabase Dashboard**
   - Go to https://supabase.com/dashboard
   - Select your project: **Time Tracker**

2. **Navigate to Email Templates**
   - Go to **Authentication** → **Email Templates**
   - Find the **"Confirm signup"** template

3. **Update the HTML Template**
   - Click on the **"Confirm signup"** template
   - Copy the contents from `supabase-email-template-confirm-signup.html`
   - Paste it into the **HTML** field
   - Make sure to keep the `{{ .ConfirmationURL }}` variable - this is required!

4. **Update the Text Template (Optional)**
   - Copy the contents from `supabase-email-template-confirm-signup-text.txt`
   - Paste it into the **Plain text** field (if available)
   - This is used for email clients that don't support HTML

5. **Verify Redirect URL**
   - Make sure the redirect URL in the template settings matches your app:
     - Production: `https://your-app.vercel.app/auth/callback`
     - Or your custom domain
   - The `{{ .ConfirmationURL }}` variable will automatically include this

6. **Save Changes**
   - Click **Save** or **Update** to save your changes

7. **Test the Email**
   - Create a test account or use the "Send test email" feature if available
   - Verify the email looks good and the confirmation link works

## Template Variables

The template uses Supabase's built-in variables:
- `{{ .ConfirmationURL }}` - The confirmation link (required)
- This will automatically include your redirect URL and token

## Notes

- The HTML template includes modern styling with gradients and emojis
- The template is mobile-responsive
- Make sure not to remove the `{{ .ConfirmationURL }}` variable
- The template includes helpful tips and feature highlights
- Both HTML and plain text versions are provided for maximum compatibility
