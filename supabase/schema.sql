-- Ludite waitlist schema.
--
-- Run this once in your Supabase project after connecting it to Vercel:
--   Supabase dashboard → SQL Editor → New query → paste this entire file → Run.
--
-- After running, head to Table Editor → "subscribers" — it'll be empty.
-- Once a real signup hits /api/subscribe, the row will appear there.

create table if not exists subscribers (
  id          bigserial primary key,
  email       text        not null unique,
  created_at  timestamptz not null default now(),
  ip          text,
  ua          text,
  referer     text
);

-- Index for sorting newest-first in the Table Editor.
create index if not exists subscribers_created_at_idx
  on subscribers (created_at desc);

-- Lock down anonymous access. Our Vercel function uses the service role key,
-- which bypasses Row Level Security, so it can still write. Public anon
-- requests can't read or write the list.
alter table subscribers enable row level security;

-- Helper view for a quick CSV-style read in the SQL editor:
--
--   select email, created_at from subscribers order by created_at desc;
--
-- Or use the Table Editor (left sidebar in Supabase) for a spreadsheet view
-- with built-in CSV export ("Download as CSV" in the top-right).
