import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { supabaseConfig } from './supabase';

let supabase: SupabaseClient;

try {
  if (!supabaseConfig.url || !supabaseConfig.anonKey) {
    throw new Error('Supabase configuration is missing. Check environment variables.');
  }

  supabase = createClient(supabaseConfig.url, supabaseConfig.anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      flowType: 'pkce',
      storage: typeof window !== 'undefined' ? window.localStorage : undefined,
    },
  });
} catch (error) {
  // Create a dummy client to prevent crashes - the app will show errors in UI
  supabase = createClient('https://placeholder.supabase.co', 'placeholder-key');
}

export { supabase };
