// src/lib/supabaseClient.js
// Lightweight wrapper to create and export a Supabase client for use in the app.
// Use NEXT_PUBLIC_ env vars for values that are safe to expose to the client (anon key).

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
	// Do not throw here to avoid breaking build in environments that don't use Supabase.
	// But log so devs notice the missing config.
	// eslint-disable-next-line no-console
	console.warn('Supabase client: NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY is not set.');
}

export function createSupabaseClient() {
	return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
		auth: { persistSession: false },
	});
}

// default exported client instance for convenience in UI code
export const supabase = createSupabaseClient();
