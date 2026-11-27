-- Fager Bistro – budsjett per måned i Nøkkeltall.
-- Kjør i Supabase → SQL Editor (én gang). Kun Thomas har tilgang.

create table if not exists public.fiken_budsjett (
  aar       int  not null,
  maned     int  not null check (maned between 1 and 12),
  gruppe    text not null check (gruppe in ('salg','varekost','lonn','adk')),
  belop_kr  numeric not null default 0,
  endret    timestamptz not null default now(),
  primary key (aar, maned, gruppe)
);

alter table public.fiken_budsjett enable row level security;
drop policy if exists "budsjett les"    on public.fiken_budsjett;
drop policy if exists "budsjett ny"     on public.fiken_budsjett;
drop policy if exists "budsjett endre"  on public.fiken_budsjett;
drop policy if exists "budsjett slett"  on public.fiken_budsjett;
create policy "budsjett les"   on public.fiken_budsjett for select to authenticated using ((select public.fiken_har_tilgang()));
create policy "budsjett ny"    on public.fiken_budsjett for insert to authenticated with check ((select public.fiken_har_tilgang()));
create policy "budsjett endre" on public.fiken_budsjett for update to authenticated using ((select public.fiken_har_tilgang())) with check ((select public.fiken_har_tilgang()));
create policy "budsjett slett" on public.fiken_budsjett for delete to authenticated using ((select public.fiken_har_tilgang()));
