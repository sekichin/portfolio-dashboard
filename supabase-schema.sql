create table if not exists public.portfolio_profiles (
  profile_id text primary key,
  core jsonb not null default '{}'::jsonb,
  revision bigint not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists public.portfolio_history (
  profile_id text not null references public.portfolio_profiles(profile_id) on delete cascade,
  day date not null,
  data jsonb not null,
  primary key (profile_id, day)
);

create index if not exists portfolio_history_profile_day_idx
  on public.portfolio_history(profile_id, day);

create table if not exists public.goal_settings (
  profile_id text primary key references public.portfolio_profiles(profile_id) on delete cascade,
  settings jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.portfolio_profiles enable row level security;
alter table public.portfolio_history enable row level security;
alter table public.goal_settings enable row level security;

revoke all on public.portfolio_profiles from anon, authenticated;
revoke all on public.portfolio_history from anon, authenticated;
revoke all on public.goal_settings from anon, authenticated;
