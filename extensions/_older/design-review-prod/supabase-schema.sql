-- Run this in the Supabase SQL Editor (Dashboard → SQL → New query).
-- Creates one row per page URL key with a JSON array of comment threads.

create table if not exists public.design_review_pages (
  page_key text primary key,
  threads jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

comment on table public.design_review_pages is 'Design-review extension: threads per page_key (origin+path+search).';

-- Prototype policies: anyone with the anon key can read/write.
-- Tighten before production (auth, workspace id column, or service role only).
alter table public.design_review_pages enable row level security;

create policy "design_review_select"
  on public.design_review_pages
  for select
  using (true);

create policy "design_review_insert"
  on public.design_review_pages
  for insert
  with check (true);

create policy "design_review_update"
  on public.design_review_pages
  for update
  using (true);

create policy "design_review_delete"
  on public.design_review_pages
  for delete
  using (true);

-- Optional future: notification targets (e.g. email per user) should live in a separate table
-- with Supabase Auth or your own app user id — do not put reviewer emails in each comment
-- row unless you have a clear retention policy and RLS. The extension currently stores
-- name/email in chrome.storage.local only.
