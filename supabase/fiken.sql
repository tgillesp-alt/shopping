-- =====================================================================
-- Fager Bistro – Fiken nøkkeltall
-- Kjør hele filen i Supabase → SQL Editor (én gang).
-- =====================================================================

-- 1) Saldo per konto per dato (hittil i år, slik Fiken rapporterer den)
create table if not exists public.fiken_saldo (
  dato        date    not null,
  konto       text    not null,
  kontonavn   text,
  saldo_ore   bigint  not null,          -- Fiken oppgir beløp i øre
  hentet      timestamptz not null default now(),
  primary key (dato, konto)
);

-- 2) Kontoer og hvordan de grupperes. Fylles automatisk første gang,
--    og kan justeres manuelt (gruppe / kategori).
create table if not exists public.fiken_kontoer (
  konto     text primary key,
  navn      text,
  gruppe    text not null default 'annet'
            check (gruppe in ('salg','varekost','lonn','annet')),
  kategori  text,                          -- f.eks. Mat, Øl, Vin, Alkoholfritt
  manuelt   boolean not null default false -- true = ikke overskriv automatisk
);

-- 3) Logg over synkroniseringer
create table if not exists public.fiken_synklogg (
  id       bigserial primary key,
  kjort    timestamptz not null default now(),
  fra      date,
  til      date,
  dager    int,
  feil     text
);

-- 4) Daglige tall: endring i saldo fra dagen før (innen samme år)
create or replace view public.fiken_daglig as
with s as (
  select dato, konto, saldo_ore,
         lag(saldo_ore) over w as forrige_saldo,
         lag(dato)      over w as forrige_dato
  from public.fiken_saldo
  window w as (partition by konto, extract(year from dato) order by dato)
)
select
  s.dato,
  s.konto,
  k.navn,
  k.gruppe,
  coalesce(k.kategori, k.navn) as kategori,
  -- salg er kredit (negativ) i Fiken → snu fortegn så omsetning blir positiv
  (case when k.gruppe = 'salg' then -1 else 1 end) *
  (case
     when s.forrige_dato = s.dato - 1 then s.saldo_ore - s.forrige_saldo
     when extract(doy from s.dato) = 1 then s.saldo_ore
     -- kontoen er ny i år, men dagen før er hentet for andre kontoer → start fra 0
     when s.forrige_dato is null and exists (
       select 1 from public.fiken_saldo x where x.dato = s.dato - 1
     ) then s.saldo_ore
     else null
   end) / 100.0 as belop_kr
from s
join public.fiken_kontoer k using (konto);

-- 5) Månedstall per gruppe/kategori
create or replace view public.fiken_maned as
select date_trunc('month', dato)::date as maned,
       gruppe, kategori,
       sum(belop_kr) as belop_kr,
       count(*) filter (where belop_kr is null) as hull
from public.fiken_daglig
group by 1,2,3;

-- 6) Tilgang: kun Thomas (thomas@gillespie.no) kan lese.
--    Flere personer: legg e-posten til i listen i hver policy.
--    Edge-funksjonen skriver
--    med service-rollen og går utenom RLS.
alter table public.fiken_saldo    enable row level security;
alter table public.fiken_kontoer  enable row level security;
alter table public.fiken_synklogg enable row level security;

drop policy if exists "les saldo"   on public.fiken_saldo;
drop policy if exists "les kontoer" on public.fiken_kontoer;
drop policy if exists "les logg"    on public.fiken_synklogg;
create policy "les saldo"   on public.fiken_saldo    for select to authenticated
  using ((auth.jwt() ->> 'email') in ('thomas@gillespie.no'));
create policy "les kontoer" on public.fiken_kontoer  for select to authenticated
  using ((auth.jwt() ->> 'email') in ('thomas@gillespie.no'));
create policy "les logg"    on public.fiken_synklogg for select to authenticated
  using ((auth.jwt() ->> 'email') in ('thomas@gillespie.no'));

-- Viewene skal respektere RLS på tabellene under
alter view public.fiken_daglig set (security_invoker = on);
alter view public.fiken_maned  set (security_invoker = on);

-- =====================================================================
-- 7) Nattlig kjøring kl. 05:00 norsk tid (04:00 UTC vinter).
--    Krever utvidelsene pg_cron og pg_net
--    (Database → Extensions → slå på begge).
--    Bytt ut <ANON_KEY> med prosjektets anon-nøkkel
--    (Project Settings → API).
-- =====================================================================
-- select cron.schedule(
--   'fiken-synk-natt',
--   '0 4 * * *',
--   $$
--   select net.http_post(
--     url     := 'https://izdclsyuplghwznsjnom.supabase.co/functions/v1/fiken-sync',
--     headers := '{"Content-Type":"application/json","Authorization":"Bearer <ANON_KEY>"}'::jsonb,
--     body    := '{}'::jsonb,
--     timeout_milliseconds := 120000
--   );
--   $$
-- );
