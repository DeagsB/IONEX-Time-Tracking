import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { supabaseConfig } from './supabase';

let supabase: SupabaseClient;

try {
  // Validate configuration
  if (!supabaseConfig.url || !supabaseConfig.anonKey) {
    console.error('❌ Supabase configuration is missing!');
    console.error('Please set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in .env.local');
    console.error('Current values:', { url: supabaseConfig.url ? 'Set' : 'Missing', anonKey: supabaseConfig.anonKey ? 'Set' : 'Missing' });
    throw new Error('Supabase configuration is missing. Please check your .env.local file.');
  }

  console.log('✅ Supabase client initializing with URL:', supabaseConfig.url.substring(0, 30) + '...');
  supabase = createClient(supabaseConfig.url, supabaseConfig.anonKey);
} catch (error) {
  console.error('❌ Failed to initialize Supabase client:', error);
  // Create a dummy client to prevent crashes - the app will show errors in UI
  supabase = createClient('https://placeholder.supabase.co', 'placeholder-key');
}

export { supabase };
