-- Our Schedule: run this once in Supabase → SQL Editor → New query → Run.
-- 1) Change the passcode on the last line before running.

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.events (
  id          uuid primary key default gen_random_uuid(),
  title       text not null,
  date        date not null,
  end_date    date,
  start_time  time,
  end_time    time,
  who         text not null default 'both',
  repeat      text not null default 'none',
  location    text,
  notes       text,
  created_by  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.app_secret (
  id        int primary key default 1 check (id = 1),
  code_hash text not null
);

-- Lock both tables: no policies = nobody can read/write them directly with the public key.
alter table public.events enable row level security;
alter table public.app_secret enable row level security;
revoke all on public.events, public.app_secret from anon, authenticated;

create or replace function public._check_code(p_code text) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not exists (select 1 from app_secret where code_hash = crypt(coalesce(p_code,''), code_hash)) then
    raise exception 'wrong passcode' using errcode = '28P01';
  end if;
end $$;

create or replace function public.list_events(p_code text) returns setof public.events
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform _check_code(p_code);
  return query select * from events order by date, start_time nulls first;
end $$;

create or replace function public.save_event(p_code text, e jsonb) returns public.events
language plpgsql security definer set search_path = public, extensions as $$
declare r events;
begin
  perform _check_code(p_code);
  insert into events (id, title, date, end_date, start_time, end_time, who, repeat, location, notes, created_by)
  values (
    coalesce(nullif(e->>'id','')::uuid, gen_random_uuid()),
    e->>'title',
    (e->>'date')::date,
    nullif(e->>'end_date','')::date,
    nullif(e->>'start_time','')::time,
    nullif(e->>'end_time','')::time,
    coalesce(nullif(e->>'who',''), 'both'),
    coalesce(nullif(e->>'repeat',''), 'none'),
    nullif(e->>'location',''),
    nullif(e->>'notes',''),
    nullif(e->>'created_by','')
  )
  on conflict (id) do update set
    title = excluded.title, date = excluded.date, end_date = excluded.end_date,
    start_time = excluded.start_time, end_time = excluded.end_time, who = excluded.who,
    repeat = excluded.repeat, location = excluded.location, notes = excluded.notes,
    updated_at = now()
  returning * into r;
  return r;
end $$;

create or replace function public.delete_event(p_code text, p_id uuid) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform _check_code(p_code);
  delete from events where id = p_id;
end $$;

revoke execute on function public._check_code(text) from public, anon, authenticated;
grant execute on function public.list_events(text), public.save_event(text, jsonb), public.delete_event(text, uuid) to anon, authenticated;

-- Set (or change) your shared passcode here:
insert into public.app_secret (id, code_hash) values (1, extensions.crypt('CHANGE-ME', extensions.gen_salt('bf')))
on conflict (id) do update set code_hash = excluded.code_hash;
