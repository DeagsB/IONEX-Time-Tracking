// Supabase configuration
export const supabaseConfig = {
  url: import.meta.env.VITE_SUPABASE_URL || '',
  anonKey: import.meta.env.VITE_SUPABASE_ANON_KEY || '',
};

// Note: You can enable Microsoft OAuth in Supabase Dashboard > Authentication > Providers
// This allows users to sign in with their Microsoft/Office 365 accounts


