-- Fager Bistro – nøkkeltall for valgfrie perioder.
-- Kjør i Supabase → SQL Editor (én gang). Respekterer tilgangsreglene (kun Thomas).

-- Sum per gruppe/kategori for en periode
create or replace function public.fiken_periode(fra date, til date)
returns table (gruppe text, kategori text, belop_kr numeric)
language sql stable security invoker
set search_path = public
as $$
  select gruppe, kategori, sum(belop_kr)
  from public.fiken_daglig
  where dato between fra and til
  group by 1, 2;
$$;

-- Salg per dag eller måned (intervall = 'day' | 'month') for grafen
create or replace function public.fiken_salg_serie(fra date, til date, intervall text default 'day')
returns table (periode date, kategori text, belop_kr numeric)
language sql stable security invoker
set search_path = public
as $$
  select date_trunc(case when intervall = 'month' then 'month' else 'day' end, dato)::date,
         kategori, sum(belop_kr)
  from public.fiken_daglig
  where gruppe = 'salg' and dato between fra and til
  group by 1, 2;
$$;

revoke execute on function public.fiken_periode(date, date) from public, anon;
revoke execute on function public.fiken_salg_serie(date, date, text) from public, anon;
grant execute on function public.fiken_periode(date, date) to authenticated;
grant execute on function public.fiken_salg_serie(date, date, text) to authenticated;
