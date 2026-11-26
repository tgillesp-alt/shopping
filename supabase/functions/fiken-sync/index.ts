// Supabase Edge Function: fiken-sync
// Henter saldo per resultatkonto (3000–8799) fra Fiken for hver dato i et
// intervall og lagrer i tabellen fiken_saldo. Henter også innkjøp
// (leverandørfakturaer) i samme intervall til tabellen fiken_innkjop.
//
// Kall:  POST /functions/v1/fiken-sync           → siste 40 dager (nattlig)
//        POST /functions/v1/fiken-sync  {"fra":"2025-01-01","til":"2025-01-31"}
// Maks 62 dager per kall (Fiken tillater bare ett kall om gangen, ca. 4/sek).
//
// Hemmeligheter (Project Settings → Edge Functions → Secrets):
//   FIKEN_API_KEY   – personlig API-nøkkel fra Fiken
//   FIKEN_ORGNR     – valgfri, standard 931735667 (Norabakken AS)
// SUPABASE_URL og SUPABASE_SERVICE_ROLE_KEY settes automatisk av Supabase.

import { createClient } from "npm:@supabase/supabase-js@2";

const FIKEN = "https://api.fiken.no/api/v2";
const KEY = Deno.env.get("FIKEN_API_KEY") ?? "";
const ORGNR = (Deno.env.get("FIKEN_ORGNR") ?? "931735667").replace(/\s/g, "");
const MAX_DAGER = 62;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fiken(path: string): Promise<any> {
  for (let forsok = 0; forsok < 4; forsok++) {
    const res = await fetch(FIKEN + path, {
      headers: { Authorization: `Bearer ${KEY}`, Accept: "application/json" },
    });
    if (res.status === 429) { await sleep(1500 * (forsok + 1)); continue; }
    if (!res.ok) throw new Error(`Fiken ${res.status} på ${path}: ${(await res.text()).slice(0, 300)}`);
    return res.json();
  }
  throw new Error(`Fiken: for mange forespørsler (${path})`);
}

function isoDag(d: Date) { return d.toISOString().slice(0, 10); }
function leggTil(dato: string, dager: number) {
  const d = new Date(dato + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + dager); return isoDag(d);
}

function gjettGruppe(konto: string): string {
  const n = parseInt(konto.slice(0, 4), 10);
  if (n >= 3000 && n < 4000) return "salg";
  if (n >= 4000 && n < 5000) return "varekost";
  if (n >= 5000 && n < 6000) return "lonn";
  if (n >= 8000 && n < 9000) return "finans";
  return "annet";
}

function gjettKategori(navn: string, gruppe: string): string | null {
  if (gruppe === "lonn") return "Lønn";
  if (gruppe === "annet") return "Andre driftskostnader";
  if (gruppe === "finans") return "Finansposter";
  const t = ` ${navn.toLowerCase()} `;
  const ord = (w: string) => new RegExp(`(^|[^a-zæøå])${w}([^a-zæøå]|$)`).test(t);
  if (/alkoholfri|mineral|brus|kaffe|te\b|juice/.test(t)) return "Alkoholfritt";
  if (/brennevin|sprit|cocktail/.test(t)) return "Brennevin";
  if (ord("vin") || /vinsalg|vinkjøp|musserende|champagne/.test(t)) return "Vin";
  if (ord("øl") || /ølsalg|ølkjøp|cider/.test(t)) return "Øl";
  if (ord("mat") || /matsalg|matvare|råvare|food/.test(t)) return "Mat";
  return null; // faller tilbake til kontonavn i viewet
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const svar = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  let fra = "", til = "";
  try {
    if (!KEY) throw new Error("FIKEN_API_KEY mangler i Supabase Secrets");

    const input = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const idag = isoDag(new Date());
    til = input.til ?? idag;
    fra = input.fra ?? leggTil(til, -39);
    if (til > idag) til = idag;
    const antall = Math.round((Date.parse(til) - Date.parse(fra)) / 86400000) + 1;
    if (!(antall > 0)) throw new Error(`Ugyldig intervall ${fra}–${til}`);
    if (antall > MAX_DAGER) throw new Error(`Maks ${MAX_DAGER} dager per kall (ba om ${antall})`);

    // Finn selskapet
    const selskaper: any[] = await fiken("/companies");
    const selskap = selskaper.find((c) => String(c.organizationNumber ?? "").replace(/\s/g, "") === ORGNR)
      ?? (selskaper.length === 1 ? selskaper[0] : null);
    if (!selskap) throw new Error(`Fant ikke selskap med org.nr ${ORGNR} blant ${selskaper.length} selskaper`);
    const slug = selskap.slug;

    const kjenteKontoer = new Set<string>(
      ((await db.from("fiken_kontoer").select("konto")).data ?? []).map((r: any) => r.konto),
    );

    let dager = 0;
    for (let dato = fra; dato <= til; dato = leggTil(dato, 1)) {
      const rader: any[] = [];
      for (let side = 0; side < 20; side++) {
        const del: any[] = await fiken(
          `/companies/${slug}/accountBalances?date=${dato}&fromAccount=3000&toAccount=8799&page=${side}&pageSize=100`,
        );
        rader.push(...del);
        await sleep(260);
        if (del.length < 100) break;
      }

      const saldo: { dato: string; konto: string; kontonavn: string | null; saldo_ore: number }[] = rader
        .filter((r) => r.code)
        .map((r) => ({ dato, konto: String(r.code), kontonavn: r.name ?? null, saldo_ore: Math.round(r.balance ?? 0) }));

      // Fiken kan utelate kontoer uten saldo → sett kjente kontoer til 0
      const returnert = new Set(saldo.map((r) => r.konto));
      for (const k of kjenteKontoer) {
        if (!returnert.has(k)) saldo.push({ dato, konto: k, kontonavn: null, saldo_ore: 0 });
      }

      const nye = saldo.filter((r) => !kjenteKontoer.has(r.konto)).map((r) => {
        const gruppe = gjettGruppe(r.konto);
        kjenteKontoer.add(r.konto);
        return { konto: r.konto, navn: r.kontonavn, gruppe, kategori: gjettKategori(r.kontonavn ?? "", gruppe) };
      });
      if (nye.length) {
        const { error } = await db.from("fiken_kontoer").upsert(nye, { onConflict: "konto", ignoreDuplicates: true });
        if (error) throw error;
      }
      if (saldo.length) {
        const { error } = await db.from("fiken_saldo").upsert(saldo, { onConflict: "dato,konto" });
        if (error) throw error;
      }
      dager++;
    }

    // Innkjøp (leverandørfakturaer og kontantkjøp) i samme periode
    const linjer: any[] = [];
    for (let side = 0; side < 50; side++) {
      const kjop: any[] = await fiken(
        `/companies/${slug}/purchases?dateGe=${fra}&dateLe=${til}&page=${side}&pageSize=100`,
      );
      await sleep(260);
      for (const p of kjop) {
        if (p.deleted) continue;
        let full = p;
        if (!Array.isArray(p.lines)) { full = await fiken(`/companies/${slug}/purchases/${p.purchaseId}`); await sleep(260); }
        (full.lines ?? []).forEach((l: any, i: number) => linjer.push({
          kjop_id: full.purchaseId,
          linje: i,
          dato: full.date,
          leverandor: full.supplier?.name ?? (full.kind === "cash_purchase" ? "Kontantkjøp" : "Ukjent"),
          leverandor_id: full.supplier?.contactId ?? null,
          konto: l.account ? String(l.account).split(":")[0] : null,
          beskrivelse: l.description ?? null,
          netto_ore: Math.round(l.netPrice ?? 0),
        }));
      }
      if (kjop.length < 100) break;
    }
    {
      const { error: delErr } = await db.from("fiken_innkjop").delete().gte("dato", fra).lte("dato", til);
      if (delErr) throw delErr;
      for (let i = 0; i < linjer.length; i += 500) {
        const { error } = await db.from("fiken_innkjop").upsert(linjer.slice(i, i + 500), { onConflict: "kjop_id,linje" });
        if (error) throw error;
      }
    }

    // Regn ut dagstallene på nytt (materialisert visning)
    {
      const { error } = await db.rpc("fiken_oppdater_daglig");
      if (error) throw error;
    }

    await db.from("fiken_synklogg").insert({ fra, til, dager });
    return svar({ ok: true, selskap: selskap.name, fra, til, dager, innkjopslinjer: linjer.length });
  } catch (e) {
    const feil = e instanceof Error ? e.message : String(e);
    await db.from("fiken_synklogg").insert({ fra: fra || null, til: til || null, dager: 0, feil });
    return svar({ ok: false, feil }, 500);
  }
});
