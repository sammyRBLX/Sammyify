# Accounts + admin setup (one time, ~15 minutes)

You need to do these 6 things in your **Supabase** and **Discord** dashboards. Nothing here is code you have to write.

## 1. Run the SQL
1. Supabase dashboard → your project → **SQL Editor** → **New query**.
2. Open `supabase-accounts.sql` from this repo, copy everything, paste it in, click **Run**.
   (If you've never run `supabase-update.sql`, run that one first. Running either again later is safe.)

> ⚠️ This switches uploads from "anyone" to "signed-in people only". Songs already in Community stay. Old uploads can still be edited/deleted by the device that uploaded them, and by you as admin.

## 2. Tell Supabase which websites may log people in
Supabase dashboard → **Authentication → URL Configuration**

* **Site URL:** `https://www.sammyify.online`
* **Redirect URLs** (add each one, click Add):
  * `https://www.sammyify.online/**`
  * `https://sammyify.online/**`
  * `https://sammyify.vercel.app/**`
  * `http://127.0.0.1:8765/**`   ← this one is for the desktop app

## 3. Turn on Discord login
1. Go to https://discord.com/developers/applications → your Sammyify application (the same one used for Rich Presence is fine) → **OAuth2**.
2. Under **Redirects**, add exactly: `https://hyfxnwekadojtecsgiix.supabase.co/auth/v1/callback` and click **Save Changes**.
3. Copy the **Client ID**, and click **Reset Secret** to get the **Client Secret**.
4. Supabase → **Authentication → Providers → Discord** → switch it **on**, paste the Client ID and Client Secret, **Save**.

## 4. Email login
Supabase → **Authentication → Providers → Email** is on by default. Choose:

* **Confirm email: ON** (recommended) — people must click a link in their inbox before they can sign in.
  Supabase's built-in email sender is very limited (a few emails per hour, and **only to people on your Supabase team**). Before real users sign up, set up your own sender: **Project Settings → Authentication → SMTP Settings** (Resend.com has a free plan; with your own domain you can send from something like `no-reply@sammyify.online`).
* **Confirm email: OFF** — people can sign in immediately with any email. Easier, but more spam/fake accounts.

Optional: **Authentication → Emails** lets you edit the wording of the confirmation and password-reset emails.

## 5. Make yourself the owner (admin)
1. Open the site, click **Sign in → Create an account** (or Continue with Discord) and make your own account.
2. Supabase → **SQL Editor**, run ONE of these (put in your email / username):
   ```sql
   update public.profiles set is_owner = true, is_admin = true
   where id = (select id from auth.users where lower(email) = lower('you@example.com'));
   ```
   ```sql
   update public.profiles set is_owner = true, is_admin = true
   where lower(username) = lower('YourUsername');
   ```
3. Refresh the site, click your name at the top → **Open admin panel**.

## What admins can do
| | Owner | Admin |
|---|---|---|
| Edit any song's title, artist, album, cover (song's **···** menu → *Admin: edit song info*) | ✅ | ✅ |
| Take down any song (**···** → *Admin: take down song*) | ✅ | ✅ |
| Ban a song's uploader (**···** → *Admin: ban …*), optionally deleting all their songs | ✅ | ✅ |
| Admin panel: search users (sees emails), ban / unban | ✅ | ✅ (not other admins) |
| Ban or unban an **email address** (even before it has an account) | ✅ | ✅ |
| Activity log of every admin action | ✅ | ✅ |
| Make / remove admins (admin panel → Users → *Make admin*) | ✅ | ❌ |
| Can be banned | ❌ | only by the owner |

**Bans:** a banned account can't sign in, can't upload, and its email can't create a new account (email *or* Discord). Admin checks happen on the server, so nobody can fake them from the browser.

## Troubleshooting
* **"Couldn't create that account (this email may be banned)"** — that email is on the banned list (admin panel → Banned emails).
* **Discord sends you back to the wrong page / "redirect URL not allowed"** — step 2 is missing the address you're using.
* **No confirmation email arrives** — see step 4 (SMTP). Check spam too.
* **Desktop app:** Discord login opens inside the app window and comes back to `http://127.0.0.1:8765/`. If another program already uses port 8765 the app picks a random port, and Discord login won't work until you close that program.

## 6. Cloud save, profile pictures, playlist pictures (v1.1)
Run `supabase-sync.sql` once (SQL Editor -> New query -> paste -> Run), **after** `supabase-accounts.sql`. Safe to run again.

It creates `user_library`, `user_playlists`, `user_settings` (each row is private to its owner), a **public** `pictures` bucket and a **private** `userdata` bucket (uploaded songs, 50 MB max each - the free-plan file limit).

What follows your account to every device once it's run: uploaded songs, saved Community/Audius/Spotify/YouTube songs, playlists (order, description, picture, date added), theme/look settings, profile picture.
Stays on the device: songs from a connected music folder, lyrics you pasted, Spotify/YouTube keys, files over 50 MB.
Until it's run the app still works; the top bar just shows "Cloud save needs setup".
Uploaded songs now exist twice if "Share songs I add to Community" is on (public copy + your private copy) - watch the free 1 GB storage.

Recommendations (bottom of a playlist) use your library + Community first, then similar artists from MusicBrainz/ListenBrainz with song info from iTunes (30-second previews; "Add" looks for a full version in Community, Audius, then Spotify/YouTube if connected). If those services can't be reached it falls back to same-genre picks.
