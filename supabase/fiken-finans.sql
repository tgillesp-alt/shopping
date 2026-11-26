-- Fager Bistro – ta med finansposter (konto 8000–8799) i nøkkeltallene.
-- Kjør i Supabase → SQL Editor (én gang), deploy ny fiken-sync, og hent historikk på nytt.

alter table public.fiken_kontoer drop constraint if exists fiken_kontoer_gruppe_check;
alter table public.fiken_kontoer add constraint fiken_kontoer_gruppe_check
  check (gruppe in ('salg','varekost','lonn','annet','finans'));
