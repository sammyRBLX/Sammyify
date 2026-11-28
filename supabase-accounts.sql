-- =====================================================================
-- Sammyify: accounts + admin tools.
-- Run ONCE in Supabase -> SQL Editor (after supabase-update.sql). Safe to run again.
--
-- What it does
--   * profiles: one row per account (username, admin/owner flags, banned flag)
--   * only signed-in, non-banned people can upload; anonymous uploads stop
--   * banned emails can't create (or re-create) an account
--   * admin functions: edit any song, take any song down, ban/unban users or emails,
--     promote/demote admins (owner only), activity log
--
-- !! This file REPLACES the row-level-security policies on `songs` and on the
-- !! `music` storage bucket (it removes the old "anyone can upload" ones).
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  username    text not null,
  is_admin    boolean not null default false,
  is_owner    boolean not null default false,
  banned      boolean not null default false,
  ban_reason  text,
  created_at  timestamptz not null default now()
);
create unique index if not exists profiles_username_lower on public.profiles (lower(username));

create table if not exists public.banned_emails (
  email      text primary key,                 -- always lower-case
  reason     text,
  banned_by  uuid,
  created_at timestamptz not null default now()
);

create table if not exists public.admin_log (
  id         bigserial primary key,
  admin_id   uuid,
  admin_name text,
  action     text not null,
  target     text,
  detail     text,
  created_at timestamptz not null default now()
);

alter table public.songs add column if not exists owner_id uuid references auth.users(id) on delete set null;

alter table public.profiles      enable row level security;
alter table public.banned_emails enable row level security;   -- no policies = only the functions below can touch it
alter table public.admin_log     enable row level security;   -- same

drop policy if exists "profiles are public" on public.profiles;
create policy "profiles are public" on public.profiles for select to anon, authenticated using (true);
-- ban_reason stays private (admins read it through admin_list_users)
revoke all on public.profiles from anon, authenticated;
grant select (id, username, is_admin, is_owner, banned, created_at) on public.profiles to anon, authenticated;

-- ---------------------------------------------------------------------
-- 2. Helpers
-- ---------------------------------------------------------------------
create or replace function public.is_banned() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select banned from public.profiles where id = auth.uid()), false)
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select (is_admin or is_owner) and not banned from public.profiles where id = auth.uid()), false)
$$;

create or replace function public.is_owner() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select is_owner and not banned from public.profiles where id = auth.uid()), false)
$$;

create or replace function public.log_admin(p_action text, p_target text, p_detail text default '')
returns void language sql security definer set search_path = public as $$
  insert into public.admin_log (admin_id, admin_name, action, target, detail)
  values (auth.uid(), (select username from public.profiles where id = auth.uid()), p_action, p_target, left(coalesce(p_detail, ''), 500));
$$;

-- ---------------------------------------------------------------------
-- 3. Sign-up triggers on auth.users
-- ---------------------------------------------------------------------
-- 3a. banned emails can't sign up (email or Discord)
create or replace function public.block_banned_email() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.email is not null and exists (select 1 from public.banned_emails where email = lower(new.email)) then
    raise exception 'This email is banned';
  end if;
  return new;
end $$;
drop trigger if exists block_banned_email on auth.users;
create trigger block_banned_email before insert on auth.users
  for each row execute function public.block_banned_email();

-- 3b. every new account gets a profile with a unique username
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare base text; cand text; tries int := 0;
begin
  base := coalesce(
    nullif(new.raw_user_meta_data->>'username', ''),
    nullif(new.raw_user_meta_data->>'user_name', ''),
    nullif(new.raw_user_meta_data->>'preferred_username', ''),
    nullif(new.raw_user_meta_data->>'full_name', ''),
    nullif(new.raw_user_meta_data->>'name', ''),
    nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
    'user');
  base := left(regexp_replace(base, '[^A-Za-z0-9_]', '', 'g'), 20);
  if length(base) < 3 then base := 'user' || substr(md5(random()::text), 1, 5); end if;
  cand := base;
  while exists (select 1 from public.profiles where lower(username) = lower(cand)) and tries < 50 loop
    tries := tries + 1;
    cand := left(base, 16) || (floor(random() * 9000) + 1000)::int::text;
  end loop;
  insert into public.profiles (id, username) values (new.id, cand);
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- accounts that already exist get profiles too
insert into public.profiles (id, username)
select u.id, 'user' || substr(md5(u.id::text), 1, 8)
from auth.users u where not exists (select 1 from public.profiles p where p.id = u.id);

-- ---------------------------------------------------------------------
-- 4. Row-level security: songs + the `music` storage bucket
-- ---------------------------------------------------------------------
alter table public.songs enable row level security;
do $$ declare r record; begin
  for r in select policyname from pg_policies where schemaname = 'public' and tablename = 'songs' loop
    execute format('drop policy %I on public.songs', r.policyname);
  end loop;
end $$;
create policy "songs are public" on public.songs for select to anon, authenticated using (true);
create policy "signed-in users add their own songs" on public.songs for insert to authenticated
  with check (owner_id = auth.uid() and not public.is_banned());
-- (no update/delete policies: edits and deletes only happen through the functions below)

do $$ declare r record; begin
  for r in select policyname from pg_policies where schemaname = 'storage' and tablename = 'objects'
           and (coalesce(qual, '') || coalesce(with_check, '')) like '%''music''%' loop
    execute format('drop policy %I on storage.objects', r.policyname);
  end loop;
end $$;
create policy "music files are public" on storage.objects for select to anon, authenticated
  using (bucket_id = 'music');
create policy "signed-in users upload music" on storage.objects for insert to authenticated
  with check (bucket_id = 'music' and not public.is_banned());
-- A file can only be deleted after its song row is gone (clean-up after deletes)
create policy "remove orphaned files" on storage.objects for delete to anon, authenticated
  using (
    bucket_id = 'music'
    and not exists (
      select 1 from public.songs s
      where s.file_url like '%/' || storage.objects.name
         or s.cover_url like '%/' || storage.objects.name
    )
  );

-- ---------------------------------------------------------------------
-- 5. Normal users: edit / delete their own songs, usernames
-- ---------------------------------------------------------------------
-- (old uploads made before accounts still work with their secret token)
create or replace function public.edit_song(p_id uuid, p_token text, p_title text, p_artist text)
returns boolean language plpgsql security definer set search_path = public, extensions as $$
begin
  if length(trim(coalesce(p_title, ''))) = 0 or public.is_banned() then return false; end if;
  update songs
     set title  = left(trim(p_title), 120),
         artist = nullif(left(trim(coalesce(p_artist, '')), 120), '')
   where id = p_id
     and ( (auth.uid() is not null and owner_id = auth.uid())
        or (owner_hash is not null and owner_hash = encode(digest(coalesce(p_token, ''), 'sha256'), 'hex')) );
  return found;
end $$;

create or replace function public.delete_song(p_id uuid, p_token text)
returns boolean language plpgsql security definer set search_path = public, extensions as $$
begin
  if public.is_banned() then return false; end if;
  delete from songs
   where id = p_id
     and ( (auth.uid() is not null and owner_id = auth.uid())
        or (owner_hash is not null and owner_hash = encode(digest(coalesce(p_token, ''), 'sha256'), 'hex')) );
  return found;
end $$;

create or replace function public.username_available(p_name text) returns boolean
language sql stable security definer set search_path = public as $$
  select p_name ~ '^[A-Za-z0-9_]{3,20}$' and not exists (select 1 from public.profiles where lower(username) = lower(p_name))
$$;

create or replace function public.set_username(p_name text) returns text
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  if public.is_banned() then raise exception 'This account is banned'; end if;
  if p_name !~ '^[A-Za-z0-9_]{3,20}$' then raise exception 'Use 3-20 letters, numbers or underscores'; end if;
  if exists (select 1 from public.profiles where lower(username) = lower(p_name) and id <> auth.uid()) then
    raise exception 'That username is taken';
  end if;
  update public.profiles set username = p_name where id = auth.uid();
  update public.songs set uploaded_by = p_name where owner_id = auth.uid();
  return p_name;
end $$;

-- ---------------------------------------------------------------------
-- 6. Admin functions (every one re-checks is_admin() on the server)
-- ---------------------------------------------------------------------
create or replace function public.admin_edit_song(p_id uuid, p_title text, p_artist text, p_album text, p_cover text default null)
returns boolean language plpgsql security definer set search_path = public as $$
declare ok boolean;
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  if length(trim(coalesce(p_title, ''))) = 0 then raise exception 'Title can''t be empty'; end if;
  update songs
     set title     = left(trim(p_title), 120),
         artist    = nullif(left(trim(coalesce(p_artist, '')), 120), ''),
         album     = nullif(left(trim(coalesce(p_album, '')), 200), ''),
         cover_url = case when p_cover is null then cover_url
                          when p_cover = '' then null
                          when p_cover like 'https://%' then left(p_cover, 500)
                          else cover_url end
   where id = p_id;
  ok := found;
  if ok then perform public.log_admin('edit_song', p_id::text, left(trim(p_title), 120)); end if;
  return ok;
end $$;

-- returns the file urls so the app can clean up storage afterwards
create or replace function public.admin_delete_song(p_id uuid) returns text[]
language plpgsql security definer set search_path = public as $$
declare f text; c text; t text;
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  delete from songs where id = p_id returning file_url, cover_url, title into f, c, t;
  if not found then return array[]::text[]; end if;
  perform public.log_admin('delete_song', p_id::text, t);
  return array_remove(array[f, c], null);
end $$;

create or replace function public.admin_list_users(p_search text default '')
returns table (id uuid, username text, email text, created_at timestamptz, banned boolean, ban_reason text,
               is_admin boolean, is_owner boolean, songs bigint)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  return query
    select p.id, p.username, u.email::text, p.created_at, p.banned, p.ban_reason, p.is_admin, p.is_owner,
           (select count(*) from public.songs s where s.owner_id = p.id)
      from public.profiles p join auth.users u on u.id = p.id
     where coalesce(p_search, '') = ''
        or p.username ilike '%' || p_search || '%'
        or u.email ilike '%' || p_search || '%'
     order by p.created_at desc
     limit 100;
end $$;

-- Ban an account: can't sign in, can't upload, its email can't register again.
create or replace function public.admin_ban_user(p_user uuid, p_reason text default '', p_delete_songs boolean default false)
returns text[] language plpgsql security definer set search_path = public as $$
declare tgt public.profiles; em text; urls text[] := array[]::text[]; r record;
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  select * into tgt from public.profiles where id = p_user;
  if not found then raise exception 'No such user'; end if;
  if p_user = auth.uid() then raise exception 'You can''t ban yourself'; end if;
  if tgt.is_owner then raise exception 'The owner can''t be banned'; end if;
  if tgt.is_admin and not public.is_owner() then raise exception 'Only the owner can ban an admin'; end if;
  select lower(email) into em from auth.users where id = p_user;
  update public.profiles set banned = true, ban_reason = left(coalesce(p_reason, ''), 300) where id = p_user;
  update auth.users set banned_until = 'infinity' where id = p_user;
  if em is not null then
    insert into public.banned_emails (email, reason, banned_by) values (em, left(coalesce(p_reason, ''), 300), auth.uid())
    on conflict (email) do update set reason = excluded.reason;
  end if;
  if p_delete_songs then
    for r in delete from public.songs where owner_id = p_user returning file_url, cover_url loop
      urls := urls || array_remove(array[r.file_url, r.cover_url], null);
    end loop;
  end if;
  perform public.log_admin('ban_user', tgt.username, left(coalesce(p_reason, ''), 300));
  return urls;
end $$;

create or replace function public.admin_unban_user(p_user uuid) returns boolean
language plpgsql security definer set search_path = public as $$
declare em text; nm text;
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  select lower(u.email), p.username into em, nm from auth.users u join public.profiles p on p.id = u.id where u.id = p_user;
  update public.profiles set banned = false, ban_reason = null where id = p_user;
  update auth.users set banned_until = null where id = p_user;
  if em is not null then delete from public.banned_emails where email = em; end if;
  perform public.log_admin('unban_user', coalesce(nm, p_user::text));
  return true;
end $$;

-- Ban an email address (even if it has no account yet). If it has one, that account is banned too.
create or replace function public.admin_ban_email(p_email text, p_reason text default '') returns boolean
language plpgsql security definer set search_path = public as $$
declare em text := lower(trim(coalesce(p_email, ''))); uid uuid;
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  if em !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'That doesn''t look like an email address'; end if;
  select id into uid from auth.users where lower(email) = em;
  if uid is not null then
    perform public.admin_ban_user(uid, p_reason, false);
  else
    insert into public.banned_emails (email, reason, banned_by) values (em, left(coalesce(p_reason, ''), 300), auth.uid())
    on conflict (email) do update set reason = excluded.reason;
    perform public.log_admin('ban_email', em, left(coalesce(p_reason, ''), 300));
  end if;
  return true;
end $$;

create or replace function public.admin_unban_email(p_email text) returns boolean
language plpgsql security definer set search_path = public as $$
declare em text := lower(trim(coalesce(p_email, ''))); uid uuid;
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  select id into uid from auth.users where lower(email) = em;
  if uid is not null then perform public.admin_unban_user(uid); end if;
  delete from public.banned_emails where email = em;
  perform public.log_admin('unban_email', em);
  return true;
end $$;

create or replace function public.admin_list_banned()
returns table (email text, reason text, created_at timestamptz, username text)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  return query
    select b.email, b.reason, b.created_at, p.username
      from public.banned_emails b
      left join auth.users u on lower(u.email) = b.email
      left join public.profiles p on p.id = u.id
     order by b.created_at desc limit 200;
end $$;

-- Only the owner can make / remove admins
create or replace function public.admin_set_admin(p_user uuid, p_value boolean) returns boolean
language plpgsql security definer set search_path = public as $$
declare nm text; own boolean;
begin
  if not public.is_owner() then raise exception 'Only the owner can change admins'; end if;
  select username, is_owner into nm, own from public.profiles where id = p_user;
  if not found then raise exception 'No such user'; end if;
  if own then raise exception 'The owner is always an admin'; end if;
  update public.profiles set is_admin = coalesce(p_value, false) where id = p_user;
  perform public.log_admin(case when p_value then 'make_admin' else 'remove_admin' end, nm);
  return true;
end $$;

create or replace function public.admin_log_list(p_limit int default 60)
returns table (created_at timestamptz, admin_name text, action text, target text, detail text)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  return query select l.created_at, l.admin_name, l.action, l.target, l.detail
                 from public.admin_log l order by l.id desc limit least(coalesce(p_limit, 60), 200);
end $$;

-- ---------------------------------------------------------------------
-- 7. Who can call what
-- ---------------------------------------------------------------------
revoke execute on function
  public.log_admin(text, text, text),
  public.admin_edit_song(uuid, text, text, text, text),
  public.admin_delete_song(uuid),
  public.admin_list_users(text),
  public.admin_ban_user(uuid, text, boolean),
  public.admin_unban_user(uuid),
  public.admin_ban_email(text, text),
  public.admin_unban_email(text),
  public.admin_list_banned(),
  public.admin_set_admin(uuid, boolean),
  public.admin_log_list(int),
  public.set_username(text)
from public, anon, authenticated;

grant execute on function
  public.admin_edit_song(uuid, text, text, text, text),
  public.admin_delete_song(uuid),
  public.admin_list_users(text),
  public.admin_ban_user(uuid, text, boolean),
  public.admin_unban_user(uuid),
  public.admin_ban_email(text, text),
  public.admin_unban_email(text),
  public.admin_list_banned(),
  public.admin_set_admin(uuid, boolean),
  public.admin_log_list(int),
  public.set_username(text)
to authenticated;

grant execute on function public.is_admin(), public.is_owner(), public.is_banned() to anon, authenticated;
grant execute on function public.username_available(text) to anon, authenticated;
grant execute on function public.edit_song(uuid, text, text, text), public.delete_song(uuid, text) to anon, authenticated;

-- ---------------------------------------------------------------------
-- 8. MAKE YOURSELF THE OWNER
--    1) Create your account on the website (email or Discord).
--    2) Remove the two dashes in front of ONE of these lines, put in your details, and run it:
-- ---------------------------------------------------------------------
-- update public.profiles set is_owner = true, is_admin = true where id = (select id from auth.users where lower(email) = lower('you@example.com'));
-- update public.profiles set is_owner = true, is_admin = true where lower(username) = lower('YourUsername');
-- After that, an "Admin panel" button appears in your account menu on the site.
