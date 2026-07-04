# 620 Notes — backend

This runs unattended, sends the nightly digest, and now also verifies staff
logins and enforces role permissions (Admin / Manager / Staff) using Supabase.

## 1. Create a Supabase project

1. Go to [supabase.com](https://supabase.com), sign up free, create a new project.
2. Once it's ready, go to **Settings -> API**. Copy:
   - **Project URL** -> `SUPABASE_URL`
   - **service_role key** (not the "anon" one) -> `SUPABASE_SERVICE_ROLE_KEY`
     (Keep this secret — it goes on the backend only, never in the board's frontend code.)
   - **anon public key** -> you'll need this one for the *board*, not the backend.

## 2. Turn on email/password login

1. In Supabase, go to **Authentication -> Providers**.
2. Make sure **Email** is enabled.
3. Go to **Authentication -> Settings** and turn **off** "Confirm email" —
   for an internal staff tool, you don't need staff to click a confirmation
   link; you're creating their accounts directly (next step).

## 3. Create the profiles table (roles live here)

Go to the **SQL Editor** in Supabase and run:

```sql
create table public.profiles (
  id uuid references auth.users(id) primary key,
  email text,
  name text not null,
  role text not null default 'staff' check (role in ('admin','manager','staff')),
  notifications_enabled boolean not null default true,
  created_at timestamptz default now()
);

-- Automatically creates a profile (default role: staff, notifications on)
-- whenever a new user is added, using their "name" from user metadata if
-- you set one, and copying their email so the digest knows where to send.
create function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, email, name, role, notifications_enabled)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'name', split_part(new.email,'@',1)), 'staff', true);
  return new;
end;
$$ language plpgsql security definer;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();
```

Notifications are now **per staff member**, not an admin-managed list — each
person controls their own "Nightly digest: On/Off" toggle right on the
board. Anyone with it on gets emailed automatically; the admin doesn't have
to maintain a recipient list at all.

## 4. Create staff accounts

1. Go to **Authentication -> Users -> Add user -> Create new user**.
2. Enter their email and a temporary password (share it with them directly —
   they can change it later from Supabase's password-reset flow if you wire
   that up, or you can just set it for them each time).
3. Under **User Metadata**, add: `{"name": "Their Name"}` so their posts show
   the right name instead of their email.
4. Repeat for each staff member, including yourself.

## 5. Make yourself (and any managers) the right role

New accounts default to `staff`. Promote people in the SQL Editor:

```sql
update public.profiles set role = 'admin'
where id = (select id from auth.users where email = 'you@example.com');

update public.profiles set role = 'manager'
where id = (select id from auth.users where email = 'your-manager@example.com');
```

**Roles:**
- **Staff** — can post notes, delete their own notes.
- **Manager** — everything staff can do, plus pin/unpin any note and delete anyone's note.
- **Admin** — everything manager can do, plus edit the recipient list, board title, and manually trigger the nightly digest.

## 6. Deploy the backend to Render

1. Push this folder to a GitHub repo (or update your existing one).
2. On [render.com](https://render.com), create/update your Web Service from that repo.
3. **Build command:** `npm install` · **Start command:** `npm start`
4. Environment variables:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `RESEND_API_KEY`
   - `FROM_EMAIL`
   - `DIGEST_CRON` (default `0 23 * * *`)
   - `TZ`
   - `CLEAR_AFTER_SEND`
5. Deploy.

## 7. Point the board at Supabase + this backend

In the board's HTML file, near the top of the `<script>` block, set:
- `API_BASE_URL` — your Render URL
- `SUPABASE_URL` — same project URL as above
- `SUPABASE_ANON_KEY` — the **anon public** key from Settings -> API (safe to
  expose in frontend code — that's what it's for)

Re-deploy that file to Netlify (or wherever it's hosted). Staff now see a
login screen; once signed in, their name is filled in automatically on every
note, and the board shows/hides pin, delete, and admin controls based on
their role.

## 8. Test

Log in as your admin account, post a note, pin it, then click **Send nightly
digest** to confirm email delivery before trusting the 11 PM schedule.
