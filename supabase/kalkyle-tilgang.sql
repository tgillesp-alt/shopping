-- Gir din innlogging (Nøkkeltall) lov til å lese og oppdatere prislisten i Kjøkkenprosent.
-- Endrer ikke tilgangen for den åpne delen av portalen.
grant select, update on public.kalkyle_varer to authenticated;

do $$
begin
  if exists (select 1 from pg_class where oid = 'public.kalkyle_varer'::regclass and relrowsecurity) then
    drop policy if exists kalkyle_varer_nokkeltall on public.kalkyle_varer;
    create policy kalkyle_varer_nokkeltall on public.kalkyle_varer
      for all to authenticated
      using ((select public.fiken_har_tilgang()))
      with check ((select public.fiken_har_tilgang()));
  end if;
end $$;
