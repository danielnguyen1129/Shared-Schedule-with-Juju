-- Shared assistant chats. Run once in Supabase → SQL Editor (no changes needed).
create table if not exists public.chat_messages (
  id         uuid primary key default gen_random_uuid(),
  thread     text not null,          -- 'together', 'daniel' or 'juju'
  author     text not null,          -- person id, or 'ai'
  content    text not null,
  created_at timestamptz not null default now()
);
create index if not exists chat_messages_created on public.chat_messages (created_at);
alter table public.chat_messages enable row level security;
revoke all on public.chat_messages from anon, authenticated;

create or replace function public.list_chat(p_code text, p_since timestamptz default null) returns setof public.chat_messages
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform _check_code(p_code);
  return query select * from (
    select * from chat_messages where p_since is null or created_at > p_since
    order by created_at desc limit 600) s order by created_at;
end $$;

create or replace function public.add_chat(p_code text, p_thread text, p_author text, p_content text) returns public.chat_messages
language plpgsql security definer set search_path = public, extensions as $$
declare r chat_messages;
begin
  perform _check_code(p_code);
  insert into chat_messages (thread, author, content) values (p_thread, p_author, left(p_content, 8000)) returning * into r;
  return r;
end $$;

create or replace function public.clear_chat(p_code text, p_thread text) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform _check_code(p_code);
  delete from chat_messages where thread = p_thread;
end $$;

grant execute on function public.list_chat(text, timestamptz), public.add_chat(text, text, text, text), public.clear_chat(text, text) to anon, authenticated;
