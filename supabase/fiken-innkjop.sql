-- Fager Bistro – innkjøp per leverandør fra Fiken.
-- Kjør i Supabase → SQL Editor (én gang). Kun Thomas kan lese.

create table if not exists public.fiken_innkjop (
  kjop_id        bigint not null,
  linje          int    not null,
  dato           date   not null,
  leverandor     text,
  leverandor_id  bigint,
  konto          text,
  beskrivelse    text,
  netto_ore      bigint not null,   -- beløp eks. mva, i øre
  hentet         timestamptz not null default now(),
  primary key (kjop_id, linje)
);
create index if not exists fiken_innkjop_dato on public.fiken_innkjop (dato);

alter table public.fiken_innkjop enable row level security;
drop policy if exists "les innkjop" on public.fiken_innkjop;
create policy "les innkjop" on public.fiken_innkjop for select to authenticated
  using ((select auth.jwt() ->> 'email') in ('thomas@gillespie.no'));

-- Innkjøp per leverandør i en periode, for én kategori (f.eks. 'Mat') eller alle varekostkontoer
create or replace function public.fiken_leverandorer(fra date, til date, kat text default null)
returns table (leverandor text, kategori text, belop_kr numeric, fakturaer bigint)
language sql stable security invoker
set search_path = public
as $$
  select i.leverandor,
         coalesce(k.kategori, k.navn) as kategori,
         sum(i.netto_ore) / 100.0,
         count(distinct i.kjop_id)
  from public.fiken_innkjop i
  join public.fiken_kontoer k on k.konto = i.konto
  where i.dato between fra and til
    and k.gruppe = 'varekost'
    and (kat is null or coalesce(k.kategori, k.navn) = kat)
  group by 1, 2;
$$;

revoke execute on function public.fiken_leverandorer(date, date, text) from public, anon;
grant execute on function public.fiken_leverandorer(date, date, text) to authenticated;
