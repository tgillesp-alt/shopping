-- Fager Bistro – raskere nøkkeltall.
-- Dagstallene lagres ferdig utregnet (materialisert) i stedet for å regnes ut
-- fra hele historikken ved hver visning. Oppdateres automatisk av fiken-sync.
-- Kjør i Supabase → SQL Editor (én gang). Erstatter fiken_daglig og fiken_maned.

-- Hvem som får se tallene (ett sted)
create or replace function public.fiken_har_tilgang()
returns boolean language sql stable
set search_path = public
as $$
  select coalesce(auth.jwt() ->> 'email', '') in ('thomas@gillespie.no');
$$;

drop view if exists public.fiken_maned;
drop view if exists public.fiken_daglig;
drop materialized view if exists public.fiken_dag;

-- Endring i saldo per konto per dag (i øre, fortegn som i Fiken)
create materialized view public.fiken_dag as
with s as (
  select dato, konto, saldo_ore,
         lag(saldo_ore) over w as forrige_saldo,
         lag(dato)      over w as forrige_dato
  from public.fiken_saldo
  window w as (partition by konto, extract(year from dato) order by dato)
),
hentet as (select distinct dato from public.fiken_saldo)
select s.dato, s.konto,
  case
    when s.forrige_dato = s.dato - 1 then s.saldo_ore - s.forrige_saldo
    when extract(doy from s.dato) = 1 then s.saldo_ore
    when s.forrige_dato is null and exists (select 1 from hentet h where h.dato = s.dato - 1) then s.saldo_ore
    else null
  end as endring_ore
from s;

create unique index fiken_dag_pk on public.fiken_dag (dato, konto);
revoke all on public.fiken_dag from public, anon, authenticated;

-- Dagstall med gruppe/kategori (kun for funksjonene under)
create view public.fiken_daglig as
select d.dato, d.konto, k.navn, k.gruppe,
       coalesce(k.kategori, k.navn) as kategori,
       (case when k.gruppe = 'salg' then -1 else 1 end) * d.endring_ore / 100.0 as belop_kr
from public.fiken_dag d
join public.fiken_kontoer k using (konto);
revoke all on public.fiken_daglig from public, anon, authenticated;

-- Oppdateres av fiken-sync etter hver henting
create or replace function public.fiken_oppdater_daglig()
returns void language sql security definer
set search_path = public
as $$ refresh materialized view public.fiken_dag; $$;
revoke execute on function public.fiken_oppdater_daglig() from public, anon, authenticated;
grant execute on function public.fiken_oppdater_daglig() to service_role;

-- Sum per gruppe/kategori for en periode
create or replace function public.fiken_periode(fra date, til date)
returns table (gruppe text, kategori text, belop_kr numeric)
language sql stable security definer
set search_path = public
as $$
  select gruppe, kategori, sum(belop_kr)
  from public.fiken_daglig
  where (select public.fiken_har_tilgang()) and dato between fra and til
  group by 1, 2;
$$;

-- Salg per dag eller måned for grafen
create or replace function public.fiken_salg_serie(fra date, til date, intervall text default 'day')
returns table (periode date, kategori text, belop_kr numeric)
language sql stable security definer
set search_path = public
as $$
  select date_trunc(case when intervall = 'month' then 'month' else 'day' end, dato)::date,
         kategori, sum(belop_kr)
  from public.fiken_daglig
  where (select public.fiken_har_tilgang()) and gruppe = 'salg' and dato between fra and til
  group by 1, 2;
$$;

-- Månedstall (13-månedstabellen og matkost)
create or replace function public.fiken_maneder(fra date)
returns table (maned date, gruppe text, kategori text, belop_kr numeric)
language sql stable security definer
set search_path = public
as $$
  select date_trunc('month', dato)::date, gruppe, kategori, sum(belop_kr)
  from public.fiken_daglig
  where (select public.fiken_har_tilgang()) and dato >= fra
  group by 1, 2, 3;
$$;

revoke execute on function public.fiken_periode(date, date) from public, anon;
revoke execute on function public.fiken_salg_serie(date, date, text) from public, anon;
revoke execute on function public.fiken_maneder(date) from public, anon;
grant execute on function public.fiken_periode(date, date) to authenticated;
grant execute on function public.fiken_salg_serie(date, date, text) to authenticated;
grant execute on function public.fiken_maneder(date) to authenticated;

-- Tilgangsreglene sjekkes én gang per spørring i stedet for per rad
drop policy if exists "les saldo"   on public.fiken_saldo;
drop policy if exists "les kontoer" on public.fiken_kontoer;
drop policy if exists "les logg"    on public.fiken_synklogg;
drop policy if exists "les innkjop" on public.fiken_innkjop;
create policy "les saldo"   on public.fiken_saldo    for select to authenticated using ((select public.fiken_har_tilgang()));
create policy "les kontoer" on public.fiken_kontoer  for select to authenticated using ((select public.fiken_har_tilgang()));
create policy "les logg"    on public.fiken_synklogg for select to authenticated using ((select public.fiken_har_tilgang()));
create policy "les innkjop" on public.fiken_innkjop  for select to authenticated using ((select public.fiken_har_tilgang()));
