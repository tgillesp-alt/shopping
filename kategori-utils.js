// Delt normaliseringsfunksjon for kategori-tekst, brukt av meny.html (skjerm + PDF)
// og kjokkenprosent.html (retter, priser, batcher). Definert ÉN gang her i stedet
// for kopiert i flere filer, slik at en fiks her gjelder alle steder automatisk.
//
// Gjør tekst-sammenligning robust mot vanlige skrivemåte-forskjeller som ellers
// lager falske "duplikate" kategorier:
//  - store/små bokstaver
//  - ekstra/dobbelt mellomrom
//  - ulike bindestrek-tegn (-, –, —, − osv.)
//  - aksenter (é vs e, ø vs o osv.) — dette var den faktiske årsaken til at
//    "ENTREES" og "Entrées – Forretter" ble behandlet som to ulike kategorier.
function normaliserKategori(s) {
  return (s || '')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2212]/g, '-')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}
