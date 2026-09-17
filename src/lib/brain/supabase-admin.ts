import { createClient, SupabaseClient } from '@supabase/supabase-js';

/**
 * Server-side Supabase client using the service_role key.
 *
 * Use this in API routes and server actions ONLY — never expose the service
 * role key to the browser. The browser uses the anon-key client in
 * `src/lib/supabase.ts`.
 *
 * Required env vars:
 *   NEXT_PUBLIC_SUPABASE_URL          — project URL (e.g. https://xxx.supabase.co)
 *   SUPABASE_SERVICE_ROLE_KEY         — service_role secret (server-only)
 *
 * For the tradingview-notes-app project (sdrjqrlvttbyrtkppfam), these are
 * supplied via Vercel env vars. The publishable key works as the anon key
 * and the secret key works as the service role key under Supabase's new
 * key format (sb_publishable_* / sb_secret_*).
 */
const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL ||
  'https://sdrjqrlvttbyrtkppfam.supabase.co';

const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

let _client: SupabaseClient | null = null;

export function getSupabaseAdmin(): SupabaseClient {
  if (!_client) {
    if (!SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error(
        'SUPABASE_SERVICE_ROLE_KEY env var is not set. Add it in Vercel → Project Settings → Environment Variables.'
      );
    }
    _client = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return _client;
}
