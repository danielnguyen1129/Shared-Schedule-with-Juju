-- Notifications. Run once in Supabase → SQL Editor.
-- BEFORE RUNNING: change YOUR-PASSCODE near the bottom to your shared passcode.

create table if not exists public.push_subs (
  endpoint   text primary key,
  person     text not null,
  sub        jsonb not null,
  tz         text not null default 'America/Los_Angeles',
  created_at timestamptz not null default now()
);
create table if not exists public.push_sent (
  key        text primary key,
  created_at timestamptz not null default now()
);
alter table public.push_subs enable row level security;
alter table public.push_sent enable row level security;
revoke all on public.push_subs, public.push_sent from anon, authenticated;

create or replace function public.save_push(p_code text, p_person text, p_sub jsonb, p_tz text) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform _check_code(p_code);
  insert into push_subs (endpoint, person, sub, tz) values (p_sub->>'endpoint', p_person, p_sub, coalesce(nullif(p_tz,''), 'America/Los_Angeles'))
  on conflict (endpoint) do update set person = excluded.person, sub = excluded.sub, tz = excluded.tz;
end $$;

create or replace function public.delete_push(p_code text, p_endpoint text) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform _check_code(p_code);
  delete from push_subs where endpoint = p_endpoint;
end $$;

create or replace function public.list_push(p_code text) returns setof public.push_subs
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform _check_code(p_code);
  return query select * from push_subs;
end $$;

-- Returns true the first time a reminder key is seen (so each reminder is sent once).
create or replace function public.mark_sent(p_code text, p_key text) returns boolean
language plpgsql security definer set search_path = public, extensions as $$
declare n int;
begin
  perform _check_code(p_code);
  delete from push_sent where created_at < now() - interval '3 days';
  insert into push_sent (key) values (p_key) on conflict do nothing;
  get diagnostics n = row_count;
  return n = 1;
end $$;

grant execute on function public.save_push(text, text, jsonb, text), public.delete_push(text, text),
  public.list_push(text), public.mark_sent(text, text) to anon, authenticated;

-- Check for upcoming reminders every minute (needed for the "1 minute before" option).
create extension if not exists pg_cron;
create extension if not exists pg_net;
select cron.unschedule('schedule-reminders') where exists (select 1 from cron.job where jobname = 'schedule-reminders');
select cron.schedule('schedule-reminders', '* * * * *', $cron$
  select net.http_post(
    url := 'https://whcfthvbpomlfbeqvyad.supabase.co/functions/v1/notify',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := jsonb_build_object('type', 'reminders', 'code', 'YOUR-PASSCODE')
  );
$cron$);
