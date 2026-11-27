-- Run once in Supabase -> SQL Editor. Safe to run again.
-- Adds covers/albums, "who uploaded this" ownership, and server-checked edit/delete.

create extension if not exists pgcrypto with schema extensions;

alter table songs add column if not exists album text;
alter table songs add column if not exists cover_url text;
alter table songs add column if not exists owner_hash text;

-- Nobody can edit rows directly any more; changes go through the functions below.
drop policy if exists "fix songs" on songs;

update storage.buckets
  set allowed_mime_types = array['audio/mpeg','audio/mp4','audio/ogg','audio/wav','audio/flac','audio/x-m4a','image/jpeg']
  where id = 'music';

-- A file can only be deleted after its song row is gone (so nobody can delete live songs' files).
drop policy if exists "remove orphaned files" on storage.objects;
create policy "remove orphaned files" on storage.objects for delete
using (
  bucket_id = 'music'
  and not exists (
    select 1 from public.songs s
    where s.file_url like '%/' || storage.objects.name
       or s.cover_url like '%/' || storage.objects.name
  )
);

-- Edit title/artist: only works with the secret token the uploader's device kept.
create or replace function public.edit_song(p_id uuid, p_token text, p_title text, p_artist text)
returns boolean language plpgsql security definer set search_path = public, extensions as $$
begin
  if length(trim(coalesce(p_title, ''))) = 0 then return false; end if;
  update songs
     set title  = left(trim(p_title), 120),
         artist = nullif(left(trim(coalesce(p_artist, '')), 120), '')
   where id = p_id
     and owner_hash is not null
     and owner_hash = encode(digest(p_token, 'sha256'), 'hex');
  return found;
end $$;

-- Delete a song: same token check.
create or replace function public.delete_song(p_id uuid, p_token text)
returns boolean language plpgsql security definer set search_path = public, extensions as $$
begin
  delete from songs
   where id = p_id
     and owner_hash is not null
     and owner_hash = encode(digest(p_token, 'sha256'), 'hex');
  return found;
end $$;

-- Auto-correct helper: can only FILL EMPTY album / cover / artist, never overwrite.
create or replace function public.fill_song_meta(p_id uuid, p_album text, p_cover text, p_artist text)
returns void language sql security definer set search_path = public as $$
  update songs
     set album     = coalesce(album, nullif(left(p_album, 200), '')),
         cover_url = coalesce(cover_url, case when p_cover like 'https://%' then left(p_cover, 500) end),
         artist    = coalesce(artist, nullif(left(p_artist, 120), ''))
   where id = p_id;
$$;

grant execute on function public.edit_song(uuid, text, text, text) to anon, authenticated;
grant execute on function public.delete_song(uuid, text) to anon, authenticated;
grant execute on function public.fill_song_meta(uuid, text, text, text) to anon, authenticated;
