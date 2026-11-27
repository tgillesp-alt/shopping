-- Fager Bistro – varelinjer fra leverandørfakturaer (PDF i Fiken) og kobling mot prislisten.
-- Kjør i Supabase → SQL Editor (én gang). Kun Thomas kan lese.

create table if not exists public.fiken_varelinje (
  kjop_id     bigint  not null,
  linje       int     not null,
  dato        date    not null,
  leverandor  text,
  varenr      text,
  navn        text,
  antall      numeric,
  enhet       text,
  enhetspris  numeric,          -- netto etter rabatt, eks. mva, per fakturaenhet
  belop       numeric,
  primary key (kjop_id, linje)
);
create index if not exists fiken_varelinje_vare on public.fiken_varelinje (leverandor, varenr, dato desc);

create table if not exists public.fiken_faktura_lest (
  kjop_id  bigint primary key,
  lest     timestamptz not null default now(),
  linjer   int,
  feil     text
);

-- Kobling: varenr hos leverandør → vare i prislisten (kalkyle_varer).
-- faktor = antall prisliste-enheter per fakturaenhet (f.eks. kartong à 9 kg mot kr/kg = 9).
create table if not exists public.vare_kobling (
  leverandor       text not null,
  varenr           text not null,
  kalkyle_vare_id  text not null,
  faktor           numeric not null default 1,
  opprettet        timestamptz not null default now(),
  primary key (leverandor, varenr)
);

alter table public.fiken_varelinje    enable row level security;
alter table public.fiken_faktura_lest enable row level security;
alter table public.vare_kobling       enable row level security;
drop policy if exists "varelinje les" on public.fiken_varelinje;
drop policy if exists "lest les"      on public.fiken_faktura_lest;
drop policy if exists "kobling alt"   on public.vare_kobling;
create policy "varelinje les" on public.fiken_varelinje    for select to authenticated using ((select public.fiken_har_tilgang()));
create policy "lest les"      on public.fiken_faktura_lest for select to authenticated using ((select public.fiken_har_tilgang()));
create policy "kobling alt"   on public.vare_kobling       for all    to authenticated using ((select public.fiken_har_tilgang())) with check ((select public.fiken_har_tilgang()));

-- Innkjøp på varekostkontoer som ikke er lest ennå (brukes av fiken-fakturaer)
create or replace function public.fiken_ulest_kjop(antall int)
returns table (kjop_id bigint, dato date, leverandor text)
language sql stable security definer set search_path = public as $$
  select i.kjop_id, max(i.dato), max(i.leverandor)
  from public.fiken_innkjop i
  join public.fiken_kontoer k on k.konto = i.konto
  where k.gruppe = 'varekost'
    and not exists (select 1 from public.fiken_faktura_lest l where l.kjop_id = i.kjop_id)
  group by i.kjop_id
  order by max(i.dato) desc
  limit antall;
$$;
create or replace function public.fiken_ulest_antall()
returns bigint language sql stable security definer set search_path = public as $$
  select count(distinct i.kjop_id)
  from public.fiken_innkjop i join public.fiken_kontoer k on k.konto = i.konto
  where k.gruppe = 'varekost'
    and not exists (select 1 from public.fiken_faktura_lest l where l.kjop_id = i.kjop_id);
$$;
revoke execute on function public.fiken_ulest_kjop(int) from public, anon, authenticated;
revoke execute on function public.fiken_ulest_antall() from public, anon;
grant execute on function public.fiken_ulest_kjop(int) to service_role;
grant execute on function public.fiken_ulest_antall() to service_role, authenticated;

-- Siste og forrige pris per vare hos hver leverandør
create or replace function public.fiken_vare_priser()
returns table (leverandor text, varenr text, navn text, enhet text,
               siste_dato date, siste_pris numeric, forrige_dato date, forrige_pris numeric,
               kjop bigint, sum_belop numeric)
language sql stable security definer set search_path = public as $$
  with l as (
    select leverandor, varenr, navn, enhet, dato, enhetspris, belop,
           row_number() over (partition by leverandor, varenr order by dato desc, kjop_id desc, linje) as nr
    from public.fiken_varelinje
    where (select public.fiken_har_tilgang())
  ),
  pr_dato as (  -- én pris per dato (snitt), for å finne forrige kjøp
    select leverandor, varenr, dato, avg(enhetspris) as pris,
           row_number() over (partition by leverandor, varenr order by dato desc) as dnr
    from l group by leverandor, varenr, dato
  )
  select s.leverandor, s.varenr, s.navn, s.enhet,
         s.dato, s.enhetspris,
         f.dato, f.pris,
         (select count(*) from l x where x.leverandor = s.leverandor and x.varenr = s.varenr),
         (select sum(belop) from l x where x.leverandor = s.leverandor and x.varenr = s.varenr)
  from l s
  left join pr_dato f on f.leverandor = s.leverandor and f.varenr = s.varenr and f.dnr = 2
  where s.nr = 1;
$$;
revoke execute on function public.fiken_vare_priser() from public, anon;
grant execute on function public.fiken_vare_priser() to authenticated;
