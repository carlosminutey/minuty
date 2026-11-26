-- minuty database (Supabase / Postgres). Run with: npm run db:setup
-- Tables are locked (row level security on, no policies): the public key cannot read or
-- write them directly. Everything goes through the functions below, which require the
-- DATA_PASSWORD (checked against a bcrypt hash in minuty_auth).

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.minuty_posts (
  id          text primary key,
  day         date not null,              -- IST calendar day the post was created
  created_at  timestamptz,
  data        jsonb not null,             -- { id, firstSeenAt, row, detail, ai, post }
  updated_at  timestamptz not null default now()
);
create index if not exists minuty_posts_day on public.minuty_posts (day);

create table if not exists public.minuty_state (
  key         text primary key,
  value       jsonb not null,
  updated_at  timestamptz not null default now()
);

create table if not exists public.minuty_requests (
  id            bigserial primary key,
  kind          text not null check (kind in ('scrape', 'retry')),
  post_id       text,
  requested_at  timestamptz not null default now(),
  done_at       timestamptz,
  result        text
);

create table if not exists public.minuty_auth (
  id         int primary key default 1 check (id = 1),
  pass_hash  text not null
);

alter table public.minuty_posts    enable row level security;
alter table public.minuty_state    enable row level security;
alter table public.minuty_requests enable row level security;
alter table public.minuty_auth     enable row level security;
revoke all on public.minuty_posts, public.minuty_state, public.minuty_requests, public.minuty_auth from anon, authenticated;

-- Password check used by every function.
create or replace function public.minuty_check(p_pass text) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if p_pass is null or not exists (select 1 from minuty_auth where pass_hash = crypt(p_pass, pass_hash)) then
    raise exception 'wrong password' using errcode = '28P01';
  end if;
end $$;

-- Scraper: state + posts from the last p_days IST days (+ any ids asked for).
create or replace function public.minuty_load(p_pass text, p_days int default 2, p_ids text[] default '{}')
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare v_today date := (now() at time zone 'Asia/Kolkata')::date;
begin
  perform minuty_check(p_pass);
  return jsonb_build_object(
    'state', (select value from minuty_state where key = 'main'),
    'items', coalesce((select jsonb_object_agg(id, data) from minuty_posts
                       where day > v_today - p_days or id = any(p_ids)), '{}'::jsonb));
end $$;

-- Scraper: upsert posts ([{id, day, created_at, data}]) and the state object.
create or replace function public.minuty_save(p_pass text, p_items jsonb, p_state jsonb)
returns int language plpgsql security definer set search_path = public, extensions as $$
declare n int;
begin
  perform minuty_check(p_pass);
  insert into minuty_posts (id, day, created_at, data, updated_at)
  select x->>'id', (x->>'day')::date, (x->>'created_at')::timestamptz, x->'data', now()
  from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) x
  on conflict (id) do update set day = excluded.day, created_at = excluded.created_at,
    data = excluded.data, updated_at = now()
  where minuty_posts.data is distinct from excluded.data;
  get diagnostics n = row_count;
  if p_state is not null then
    insert into minuty_state (key, value, updated_at) values ('main', p_state, now())
    on conflict (key) do update set value = excluded.value, updated_at = now();
  end if;
  return n;
end $$;

-- Web page: overview (state summary, list of days with counts, open requests).
create or replace function public.minuty_overview(p_pass text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare s jsonb;
begin
  perform minuty_check(p_pass);
  select value into s from minuty_state where key = 'main';
  return jsonb_build_object(
    'updatedAt', s->'updatedAt',
    'sourceUrl', s->'sourceUrl',
    'runs', coalesce(s->'runs', '[]'::jsonb),
    'days', coalesce((select jsonb_object_agg(day::text, jsonb_build_object(
        'count', n, 'unlocked', u, 'rewritten', r, 'posted', p)) from (
      select day, count(*) n,
        count(*) filter (where (data->'detail'->>'unlocked')::boolean) u,
        count(*) filter (where data ? 'ai' and data->'ai' <> 'null'::jsonb) r,
        count(*) filter (where data->'post'->>'postedAt' is not null) p
      from minuty_posts group by day) d), '{}'::jsonb),
    'requests', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'kind', kind, 'post_id', post_id,
        'requested_at', requested_at, 'done_at', done_at, 'result', result) order by id desc)
      from (select * from minuty_requests order by id desc limit 20) q), '[]'::jsonb));
end $$;

-- Web page: one day's posts.
create or replace function public.minuty_day(p_pass text, p_day date)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
begin
  perform minuty_check(p_pass);
  return coalesce((select jsonb_object_agg(id, data) from minuty_posts where day = p_day), '{}'::jsonb);
end $$;

-- Web page buttons: ask for a scrape now, or a retry of posting one post.
create or replace function public.minuty_request(p_pass text, p_kind text, p_post_id text default null)
returns bigint language plpgsql security definer set search_path = public, extensions as $$
declare v_id bigint;
begin
  perform minuty_check(p_pass);
  select id into v_id from minuty_requests
   where done_at is null and kind = p_kind and post_id is not distinct from p_post_id limit 1;
  if v_id is null then
    insert into minuty_requests (kind, post_id) values (p_kind, p_post_id) returning id into v_id;
  end if;
  return v_id;
end $$;

-- Runner: open requests, and marking them done.
create or replace function public.minuty_pending(p_pass text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
begin
  perform minuty_check(p_pass);
  return coalesce((select jsonb_agg(jsonb_build_object('id', id, 'kind', kind, 'post_id', post_id) order by id)
                   from minuty_requests where done_at is null), '[]'::jsonb);
end $$;

create or replace function public.minuty_done(p_pass text, p_ids bigint[], p_result text)
returns void language plpgsql security definer set search_path = public, extensions as $$
begin
  perform minuty_check(p_pass);
  update minuty_requests set done_at = now(), result = p_result where id = any(p_ids) and done_at is null;
  delete from minuty_requests where done_at < now() - interval '14 days';
end $$;

revoke all on function public.minuty_check(text) from public, anon, authenticated;
grant execute on function public.minuty_load(text, int, text[]),
  public.minuty_save(text, jsonb, jsonb), public.minuty_overview(text), public.minuty_day(text, date),
  public.minuty_request(text, text, text), public.minuty_pending(text),
  public.minuty_done(text, bigint[], text) to anon, authenticated;
