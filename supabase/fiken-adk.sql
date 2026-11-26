-- Fager Bistro – andre driftskostnader (ADK) per konto.
-- Kjør i Supabase → SQL Editor (én gang).

create or replace function public.fiken_adk(fra date, til date)
returns table (konto text, navn text, belop_kr numeric)
language sql stable security definer
set search_path = public
as $$
  select d.konto, k.navn, sum(d.endring_ore) / 100.0
  from public.fiken_dag d
  join public.fiken_kontoer k using (konto)
  where (select public.fiken_har_tilgang())
    and k.gruppe = 'annet'
    and coalesce(k.kategori, '') <> 'Tips'
    and d.dato between fra and til
  group by 1, 2;
$$;

revoke execute on function public.fiken_adk(date, date) from public, anon;
grant execute on function public.fiken_adk(date, date) to authenticated;
