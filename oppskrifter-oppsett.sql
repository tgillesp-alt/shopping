-- Fager Portal – Oppskrifter
-- Lim inn hele denne filen i Supabase → SQL Editor → Run. Kan kjøres flere ganger.

create table if not exists public.oppskrifter (
  id               uuid primary key default gen_random_uuid(),
  paprika_uid      text unique,
  navn             text not null,
  kategorier       text[] not null default '{}',
  ingredienser     text,
  fremgangsmaate   text,
  notater          text,
  porsjoner        text,
  forberedelsestid text,
  tilberedningstid text,
  vanskelighetsgrad text,
  vurdering        int not null default 0,
  kilde            text,
  kilde_url        text,
  naeringsinnhold  text,
  bilde_url        text,
  opprettet        timestamptz not null default now(),
  oppdatert        timestamptz not null default now()
);

create index if not exists oppskrifter_navn_idx on public.oppskrifter (lower(navn));

create or replace function public.oppskrifter_touch() returns trigger language plpgsql as $$
begin new.oppdatert = now(); return new; end $$;
drop trigger if exists oppskrifter_touch on public.oppskrifter;
create trigger oppskrifter_touch before update on public.oppskrifter
  for each row execute function public.oppskrifter_touch();

-- Samme åpne tilgang som resten av portalen (anon-nøkkelen)
alter table public.oppskrifter enable row level security;
drop policy if exists "oppskrifter_alle" on public.oppskrifter;
create policy "oppskrifter_alle" on public.oppskrifter for all to anon, authenticated using (true) with check (true);

-- Bildelagring
insert into storage.buckets (id, name, public)
values ('oppskrifter', 'oppskrifter', true)
on conflict (id) do update set public = true;

drop policy if exists "oppskrifter_bilder_les" on storage.objects;
drop policy if exists "oppskrifter_bilder_skriv" on storage.objects;
drop policy if exists "oppskrifter_bilder_endre" on storage.objects;
drop policy if exists "oppskrifter_bilder_slett" on storage.objects;
create policy "oppskrifter_bilder_les"   on storage.objects for select to anon, authenticated using (bucket_id = 'oppskrifter');
create policy "oppskrifter_bilder_skriv" on storage.objects for insert to anon, authenticated with check (bucket_id = 'oppskrifter');
create policy "oppskrifter_bilder_endre" on storage.objects for update to anon, authenticated using (bucket_id = 'oppskrifter');
create policy "oppskrifter_bilder_slett" on storage.objects for delete to anon, authenticated using (bucket_id = 'oppskrifter');
