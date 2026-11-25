import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL?.trim();
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim();

export const supabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey);

export const supabase = supabaseConfigured
  ? createClient(supabaseUrl, supabaseAnonKey)
  : null;

export function requireSupabase() {
  if (!supabase) {
    throw new Error(
      "Backend is not configured. Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY, then restart the app.",
    );
  }
  return supabase;
}

export function getErrorMessage(error, fallback = "The request failed.") {
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}
