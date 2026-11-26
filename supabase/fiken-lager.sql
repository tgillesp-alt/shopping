-- Fager Bistro – manuell lagerendring i nøkkeltallene.
-- Lagerøkning trekkes fra varekosten (og lagerreduksjon legges til) fra datoen
-- den registreres. Registreres fra Nøkkeltall-siden. Kun Thomas har tilgang.
-- Kjør i Supabase → SQL Editor (én gang). Forutsetter fiken-ytelse.sql og fiken-tips.sql.

create table if not exists public.fiken_lagerendring (
  id        bigserial primary key,
  dato      date not null,
  kategori  text not null,              -- samme navn som varekost-kategorien, f.eks. Mat, Vin
  belop_kr  numeric not null,           -- positiv = lageret har økt, negativ = lageret har gått ned
  merknad   text,
  opprettet timestamptz not null default now()
);

alter table public.fiken_lagerendring enable row level security;
drop policy if exists "lager les"    on public.fiken_lagerendring;
drop policy if exists "lager ny"     on public.fiken_lagerendring;
drop policy if exists "lager slett"  on public.fiken_lagerendring;
create policy "lager les"   on public.fiken_lagerendring for select to authenticated using ((select public.fiken_har_tilgang()));
create policy "lager ny"    on public.fiken_lagerendring for insert to authenticated with check ((select public.fiken_har_tilgang()));
create policy "lager slett" on public.fiken_lagerendring for delete to authenticated using ((select public.fiken_har_tilgang()));

create or replace view public.fiken_daglig as
select d.dato, d.konto, k.navn, k.gruppe,
       coalesce(k.kategori, k.navn) as kategori,
       (case when k.gruppe = 'salg' then -1 else 1 end) * d.endring_ore / 100.0 as belop_kr
from public.fiken_dag d
join public.fiken_kontoer k using (konto)
union all
-- Tips utbetalt via lønn: motpost i lønnsgruppen
select d.dato, d.konto, k.navn, 'lonn', 'Tips utbetalt',
       d.endring_ore / 100.0
from public.fiken_dag d
join public.fiken_kontoer k using (konto)
where k.kategori = 'Tips'
union all
-- Manuell lagerendring: lagerøkning reduserer varekosten
select l.dato, 'lager', coalesce(l.merknad, 'Lagerendring'), 'varekost', l.kategori,
       -l.belop_kr
from public.fiken_lagerendring l;

revoke all on public.fiken_daglig from public, anon, authenticated;
