-- Run once in Supabase -> SQL Editor (adds covers/albums + lets the app save auto-corrections)
alter table songs add column if not exists album text;
alter table songs add column if not exists cover_url text;
create policy "fix songs" on songs for update using (true) with check (true);
update storage.buckets
  set allowed_mime_types = array['audio/mpeg','audio/mp4','audio/ogg','audio/wav','audio/flac','audio/x-m4a','image/jpeg']
  where id = 'music';
