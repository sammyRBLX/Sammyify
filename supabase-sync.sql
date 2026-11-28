-- =====================================================================
-- Sammyify: per-account cloud save (library, playlists, settings) +
--           profile pictures + playlist pictures.
-- Run ONCE in Supabase -> SQL Editor, AFTER supabase-accounts.sql. Safe to run again.
--
-- What it adds
--   * user_library   : every song in your library (uploads + saved Community/Audius/Spotify/YouTube songs)
--   * user_playlists : your playlists (name, description, picture, ordered songs, date added)
--   * user_settings  : your theme / look & feel settings
--   * profiles.avatar_url + set_avatar()  : profile picture (public, shown next to your name)
--   * storage bucket `pictures` (public)   : profile + playlist pictures
--   * storage bucket `userdata` (PRIVATE)  : your own uploaded song files; only you can read them
--
-- Everything is locked to the signed-in owner with row-level security.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Profile picture
-- ---------------------------------------------------------------------
alter table public.profiles add column if not exists avatar_url text;
grant select (avatar_url) on public.profiles to anon, authenticated;

create or replace function public.set_avatar(p_url text) returns text
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  if public.is_banned() then raise exception 'This account is banned'; end if;
  if p_url is not null and p_url <> '' and p_url not like ('%/storage/v1/object/public/pictures/' || auth.uid()::text || '/%') then
    raise exception 'That picture is not allowed';
  end if;
  update public.profiles set avatar_url = nullif(left(coalesce(p_url, ''), 500), '') where id = auth.uid();
  return nullif(p_url, '');
end $$;
revoke execute on function public.set_avatar(text) from public, anon;
grant  execute on function public.set_avatar(text) to authenticated;

-- ---------------------------------------------------------------------
-- 2. Tables
-- ---------------------------------------------------------------------
create table if not exists public.user_library (
  owner_id   uuid not null default auth.uid() references auth.users(id) on delete cascade,
  track_id   text not null,                       -- the id the app uses for this song
  kind       text not null check (kind in ('file','sb','au','sp','yt','pv')),
  title      text not null,
  artist     text,
  album      text,
  cover_url  text,
  file_path  text,                                -- kind = 'file': path inside the `userdata` bucket
  size       bigint,
  meta       jsonb not null default '{}'::jsonb,  -- source specific bits (stream url, ids, ...)
  added_at   timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (owner_id, track_id)
);

create table if not exists public.user_playlists (
  owner_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  id          uuid not null,
  name        text not null,
  description text,
  image_url   text,
  track_ids   jsonb not null default '[]'::jsonb,  -- ordered list of track ids
  added       jsonb not null default '{}'::jsonb,  -- track id -> time it was added (ms)
  position    int  not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (owner_id, id)
);

create table if not exists public.user_settings (
  owner_id   uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  settings   jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.user_library   enable row level security;
alter table public.user_playlists enable row level security;
alter table public.user_settings  enable row level security;

drop policy if exists "own library"   on public.user_library;
drop policy if exists "own playlists" on public.user_playlists;
drop policy if exists "own settings"  on public.user_settings;
create policy "own library"   on public.user_library   for all to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy "own playlists" on public.user_playlists for all to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy "own settings"  on public.user_settings  for all to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create or replace function public.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
drop trigger if exists touch_user_library   on public.user_library;
drop trigger if exists touch_user_playlists on public.user_playlists;
drop trigger if exists touch_user_settings  on public.user_settings;
create trigger touch_user_library   before update on public.user_library   for each row execute function public.touch_updated_at();
create trigger touch_user_playlists before update on public.user_playlists for each row execute function public.touch_updated_at();
create trigger touch_user_settings  before update on public.user_settings  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------
-- 3. Storage buckets
--      pictures : public  (profile pictures, playlist pictures, song covers) - 5 MB, images only
--      userdata : private (your uploaded songs)                              - 50 MB per file
--    (50 MB is the most a free Supabase project allows per file.)
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('pictures', 'pictures', true, 5242880, array['image/jpeg','image/png','image/webp'])
on conflict (id) do update set public = true, file_size_limit = 5242880,
  allowed_mime_types = array['image/jpeg','image/png','image/webp'];

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('userdata', 'userdata', false, 52428800,
  array['audio/mpeg','audio/mp4','audio/ogg','audio/wav','audio/flac','audio/x-m4a','audio/aac','audio/opus','application/octet-stream'])
on conflict (id) do update set public = false, file_size_limit = 52428800,
  allowed_mime_types = array['audio/mpeg','audio/mp4','audio/ogg','audio/wav','audio/flac','audio/x-m4a','audio/aac','audio/opus','application/octet-stream'];

do $$ declare r record; begin
  for r in select policyname from pg_policies where schemaname = 'storage' and tablename = 'objects'
           and policyname in ('pictures are public','own pictures insert','own pictures update','own pictures delete',
                              'own userdata read','own userdata insert','own userdata update','own userdata delete') loop
    execute format('drop policy %I on storage.objects', r.policyname);
  end loop;
end $$;

-- pictures: anyone can look, only you can write inside your own folder  (<your user id>/...)
create policy "pictures are public" on storage.objects for select to anon, authenticated
  using (bucket_id = 'pictures');
create policy "own pictures insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'pictures' and (storage.foldername(name))[1] = auth.uid()::text and not public.is_banned());
create policy "own pictures update" on storage.objects for update to authenticated
  using (bucket_id = 'pictures' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'pictures' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "own pictures delete" on storage.objects for delete to authenticated
  using (bucket_id = 'pictures' and (storage.foldername(name))[1] = auth.uid()::text);

-- userdata: private. Only you can read / write / delete files in your own folder.
create policy "own userdata read" on storage.objects for select to authenticated
  using (bucket_id = 'userdata' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "own userdata insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'userdata' and (storage.foldername(name))[1] = auth.uid()::text and not public.is_banned());
create policy "own userdata update" on storage.objects for update to authenticated
  using (bucket_id = 'userdata' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'userdata' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "own userdata delete" on storage.objects for delete to authenticated
  using (bucket_id = 'userdata' and (storage.foldername(name))[1] = auth.uid()::text);
