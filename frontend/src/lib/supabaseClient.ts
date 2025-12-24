import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { supabaseConfig } from './supabase';

let supabase: SupabaseClient;

try {
  // Validate configuration
  console.log('🔍 Environment variables check:');
  console.log('  VITE_SUPABASE_URL:', supabaseConfig.url || '❌ MISSING');
  console.log('  VITE_SUPABASE_ANON_KEY:', supabaseConfig.anonKey ? `✅ Set (${supabaseConfig.anonKey.substring(0, 20)}...)` : '❌ MISSING');
  
  if (!supabaseConfig.url || !supabaseConfig.anonKey) {
    console.error('❌ Supabase configuration is missing!');
    console.error('Please set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in Vercel environment variables');
    throw new Error('Supabase configuration is missing. Check Vercel environment variables.');
  }

  console.log('✅ Supabase client initializing with URL:', supabaseConfig.url.substring(0, 30) + '...');
  supabase = createClient(supabaseConfig.url, supabaseConfig.anonKey);
} catch (error) {
  console.error('❌ Failed to initialize Supabase client:', error);
  // Create a dummy client to prevent crashes - the app will show errors in UI
  supabase = createClient('https://placeholder.supabase.co', 'placeholder-key');
}

export { supabase };
