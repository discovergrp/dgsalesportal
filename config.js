// Public config — the anon key is SAFE to expose in frontend code.
// It only allows what Row Level Security (schema.sql) permits.
// Never put the service_role key here or anywhere in this folder.

const SUPABASE_URL = "https://zunsfmuyezhllbgmbkzh.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inp1bnNmbXV5ZXpobGxiZ21ia3poIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQyMTE2MDYsImV4cCI6MjA5OTc4NzYwNn0.sj3sQSRpPGQW2qZsIzyox1jonhKF30Y51KI5Pqb5h0U";

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
