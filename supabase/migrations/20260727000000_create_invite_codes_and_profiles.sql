create extension if not exists pgcrypto;

create table if not exists public.invite_codes (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,
  is_used boolean not null default false,
  is_revoked boolean not null default false,
  used_by_user_id uuid references auth.users(id) on delete set null,
  used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.invite_codes enable row level security;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  full_name text,
  avatar_url text,
  is_admin boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "Users can view own profile"
  on public.profiles
  for select
  using (auth.uid() = id);

create policy "Users can insert own profile"
  on public.profiles
  for insert
  with check (auth.uid() = id);

create policy "Users can update own profile"
  on public.profiles
  for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

create or replace function public.claim_invite_code(
  p_code text,
  p_user_id uuid,
  p_email text,
  p_full_name text,
  p_avatar_url text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed_invite_id uuid;
begin
  update public.invite_codes
  set is_used = true,
      used_by_user_id = p_user_id,
      used_at = now()
  where code = p_code
    and is_used = false
    and is_revoked = false
  returning id into claimed_invite_id;

  if claimed_invite_id is null then
    raise exception 'Invalid or already used invite code.';
  end if;

  insert into public.profiles (id, email, full_name, avatar_url)
  values (p_user_id, p_email, p_full_name, p_avatar_url)
  on conflict (id) do update
    set email = excluded.email,
        full_name = excluded.full_name,
        avatar_url = excluded.avatar_url;
end;
$$;

insert into public.invite_codes (code)
values ('SOLAR-SECRET-2026')
on conflict (code) do nothing;

create index if not exists invite_codes_created_at_idx
  on public.invite_codes (created_at desc);
