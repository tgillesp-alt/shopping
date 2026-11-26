-- Fager Bistro – trekk tips ut av lønnskostnaden.
-- Tips mottas på konto 3900 (kategori «Tips», gruppe «annet») og utbetales
-- i egne lønnskjøringer på de vanlige lønnskontoene. Lønnskostnaden reduseres
-- derfor med mottatt tips. Arbeidsgiveravgift på tips blir stående som kostnad.
-- Kjør i Supabase → SQL Editor (én gang).

create or replace view public.fiken_daglig as
select d.dato, d.konto, k.navn, k.gruppe,
       coalesce(k.kategori, k.navn) as kategori,
       (case when k.gruppe = 'salg' then -1 else 1 end) * d.endring_ore / 100.0 as belop_kr
from public.fiken_dag d
join public.fiken_kontoer k using (konto)
union all
-- Tips utbetalt via lønn: motpost i lønnsgruppen (negativt beløp = lavere lønnskost)
select d.dato, d.konto, k.navn, 'lonn' as gruppe, 'Tips utbetalt' as kategori,
       d.endring_ore / 100.0 as belop_kr
from public.fiken_dag d
join public.fiken_kontoer k using (konto)
where k.kategori = 'Tips';

revoke all on public.fiken_daglig from public, anon, authenticated;
