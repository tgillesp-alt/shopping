// Supabase Edge Function: fiken-fakturaer
// Leser varelinjer (varenr, navn, antall, enhet, nettopris) fra PDF-vedlegg på
// innkjøp i Fiken og lagrer dem i fiken_varelinje. Leser bare innkjøp på
// varekostkontoer som ikke er lest før. Maks 15 per kall – kall flere ganger.
//
// Kall:  POST /functions/v1/fiken-fakturaer   {}  → { behandlet, gjenstaar }
// Hemmeligheter: FIKEN_API_KEY (samme som fiken-sync), FIKEN_ORGNR (valgfri).

// @ts-nocheck
import { createClient } from "npm:@supabase/supabase-js@2";
import { getDocumentProxy } from "npm:unpdf";

const FIKEN = "https://api.fiken.no/api/v2";
const KEY = Deno.env.get("FIKEN_API_KEY") ?? "";
const ORGNR = (Deno.env.get("FIKEN_ORGNR") ?? "931735667").replace(/\s/g, "");
const PER_KALL = 15;
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fiken(path, binær = false) {
  for (let forsok = 0; forsok < 4; forsok++) {
    const res = await fetch(path.startsWith("http") ? path : FIKEN + path, { headers: { Authorization: `Bearer ${KEY}` } });
    if (res.status === 429) { await sleep(1500 * (forsok + 1)); continue; }
    if (!res.ok) throw new Error(`Fiken ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return binær ? { buf: await res.arrayBuffer(), type: res.headers.get("content-type") || "" } : res.json();
  }
  throw new Error("Fiken: for mange forespørsler");
}

// ---------------- Fakturatolker ----------------
// Fager Bistro – leser varelinjer fra leverandørfakturaer (PDF med tekst).
// Generisk: finner linjer der antall × pris (× (1 − rabatt)) ≈ beløp.
// Brukes både i Node (test) og i Supabase Edge Function (Deno).

const TALL = /^-?\d{1,3}(?:[  ]\d{3})*(?:,\d+)?$|^-?\d+(?:[.,]\d+)?$/;
const tall = (s) => Number(String(s).replace(/[  ]/g, "").replace(",", "."));
const erTall = (s) => TALL.test(String(s).trim());
const IKKE_VARE = /^(sum|total|mva|grunnlag|fakturagebyr|frakt|tillegg|nettobeløp|avgiftsfritt|fritatt|å betale|rabatt|øreavrunding|pant)/i;

// Bygg linjer fra tekstbiter med posisjon
async function lesLinjer(pdfBytes: ArrayBuffer, getDocumentProxy: any) {
  const pdf = await getDocumentProxy(new Uint8Array(pdfBytes));
  const linjer = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const side = await pdf.getPage(p);
    const innhold = await side.getTextContent();
    const biter = innhold.items
      .filter((i) => i.str && i.str.trim())
      .map((i) => ({ s: i.str.trim(), x: i.transform[4], y: i.transform[5], w: i.width || 0 }));
    biter.sort((a, b) => b.y - a.y || a.x - b.x);
    let rad = [], y = null;
    for (const b of biter) {
      if (y === null || Math.abs(b.y - y) <= 2.5) { rad.push(b); y = y ?? b.y; }
      else { linjer.push(rad.sort((a, c) => a.x - c.x)); rad = [b]; y = b.y; }
    }
    if (rad.length) linjer.push(rad.sort((a, c) => a.x - c.x));
  }
  // Slå sammen tekstbiter som står tett (samme kolonne-ord) – men aldri to tall
  return linjer.map((rad) => {
    const ut = [];
    for (const b of rad) {
      const forrige = ut[ut.length - 1];
      const tett = forrige && b.x - (forrige.x + forrige.w) < 1.5;
      if (tett && !/^\d/.test(b.s) && !erTall(forrige.s)) { forrige.s += b.s; forrige.w = b.x + b.w - forrige.x; }
      else ut.push({ ...b });
    }
    return ut.flatMap((b) => del(b.s));
  });
}

const ENHET = "(?:stk\\.?|kg|liter|ltr|l|kartong|krt|brett|kanne|boks|pakke|pk|kasse|bunt|bt|nett|gl|glass|flaske|fl|pose|spann|dunk|sekk)";
// Del opp tekstbiter som består av tall og enheter («10 kg», «15 30001», «8 Brett EGG 155,70»)
function del(s) {
  const t = s.trim();
  if (/^\d/.test(t) && /\s/.test(t)) {
    const deler = t.match(/\d{1,3}(?:[ \u00a0]\d{3})+(?:,\d+)?(?![\d,])|\d+(?:[.,]\d+)?|[^\s\d]+/g) || [t];
    return deler;
  }
  // Navn som slutter med «… 18 Stk.»: skill ut antall og enhet
  const m = t.match(new RegExp("^(.*\\S)\\s+(\\d+(?:,\\d+)?)\\s+(" + ENHET + ")$", "i"));
  if (m && /[A-Za-zÆØÅæøå]{3,}/.test(m[1])) return [m[1], m[2], m[3]];
  return [t];
}

// Finn antall, pris og rabatt slik at produktet stemmer med beløpet
function løs(tallListe, belop) {
  const nær = (a, b) => Math.abs(a - b) <= Math.max(0.004 * Math.abs(b), 0.6);
  const n = tallListe.length;
  // 1) antall × pris = beløp (uten rabatt) – foretrekk siste pris (netto)
  for (let j = n - 1; j >= 0; j--) for (let i = 0; i < j; i++) {
    if (nær(tallListe[i].v * tallListe[j].v, belop) && tallListe[i].v > 0) return { a: i, p: j };
  }
  // 2) antall × pakningsstørrelse × pris = beløp
  for (let j = n - 1; j >= 0; j--) for (let i = 0; i < j; i++) for (let k = i + 1; k < j; k++) {
    if (tallListe[k].v > 1 && nær(tallListe[i].v * tallListe[k].v * tallListe[j].v, belop)) return { a: i, k, p: j };
  }
  // 3) med rabatt (prosent etter prisen)
  for (let j = 0; j < n; j++) for (let r = j + 1; r < n; r++) {
    const rab = tallListe[r].v; if (!(rab > 0 && rab < 100)) continue;
    for (let i = 0; i < j; i++) if (nær(tallListe[i].v * tallListe[j].v * (1 - rab / 100), belop)) return { a: i, p: j, r };
    if (nær(tallListe[j].v * (1 - rab / 100), belop)) return { a: -1, p: j, r };
  }
  return null;
}

function tolkLinjer(linjer) {
  const varer = [];
  for (let n = 0; n < linjer.length; n++) {
    let t = linjer[n];
    const harNavn = (rad) => rad.some((s) => /[A-Za-zÆØÅæøå]{3,}/.test(s) && !erTall(s));
    const sisteErBelop = (rad) => rad.length && erTall(rad[rad.length - 1]) && /,\d{2}$/.test(rad[rad.length - 1]);
    if (!sisteErBelop(t)) continue;
    const belop = tall(t[t.length - 1]);
    if (!(belop > 0)) continue;

    // Navn = første lengre tekstbit; varenr = biten rett før navnet
    const navnIdx = t.findIndex((s) => /[A-Za-zÆØÅæøå]{3,}/.test(s) && !erTall(s));
    if (navnIdx < 0) continue;
    const navn = t[navnIdx].replace(/\s+/g, " ").trim();
    if (IKKE_VARE.test(navn)) continue;
    const forNavn = t.slice(0, navnIdx);
    const varenr = forNavn.length ? forNavn[forNavn.length - 1] : null;
    if (!varenr || !/^[\dA-Z][\w-]{2,}$/i.test(varenr)) continue;

    // Tall etter navnet (uten selve beløpet)
    const etter = [];
    for (let i = navnIdx + 1; i < t.length - 1; i++) if (erTall(t[i])) etter.push({ v: tall(t[i]), i });
    const l = løs(etter, belop);
    if (!l) continue;
    const ord = (idx) => { const s = t[idx + 1]; return s && !erTall(s) ? s : null; };
    let antall, enhet;
    if (l.a === -1) { antall = 1; enhet = null; }
    else if (l.k !== undefined) { antall = etter[l.a].v * etter[l.k].v; enhet = ord(etter[l.k].i); }
    else { antall = etter[l.a].v; enhet = ord(etter[l.a].i); }
    const tilleggsNavn = t.slice(navnIdx + 1).filter((s) => !erTall(s) && s !== enhet && /[A-Za-zÆØÅæøå]{3,}/.test(s));
    varer.push({
      varenr,
      navn: [navn, ...tilleggsNavn.filter((s) => s.length > 3 && !/^(kg|stk|liter|kartong|brett|pakke|kasse|bunt|nett|boks|kanne|gl)$/i.test(s))].join(" "),
      antall: Math.round(antall * 1000) / 1000,
      enhet: enhet ? enhet.toLowerCase() : null,
      enhetspris: Math.round((belop / antall) * 100) / 100,   // netto etter rabatt, eks. mva
      listepris: etter[l.p].v,
      rabatt: l.r !== undefined ? etter[l.r].v : 0,
      belop,
    });
  }
  return varer;
}

async function lesFaktura(pdfBytes: ArrayBuffer, getDocumentProxy: any) {
  return tolkLinjer(await lesLinjer(pdfBytes, getDocumentProxy));
}

// ---------------- Hovedløkke ----------------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const svar = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
  const db = createClient(Deno.env.get("SUPABASE_URL"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));
  try {
    if (!KEY) throw new Error("FIKEN_API_KEY mangler i Supabase Secrets");
    const selskaper = await fiken("/companies");
    const selskap = selskaper.find((c) => String(c.organizationNumber ?? "").replace(/\s/g, "") === ORGNR) ?? (selskaper.length === 1 ? selskaper[0] : null);
    if (!selskap) throw new Error("Fant ikke selskapet i Fiken");
    const slug = selskap.slug;

    const { data: kjop, error } = await db.rpc("fiken_ulest_kjop", { antall: PER_KALL });
    if (error) throw error;
    let behandlet = 0, linjerTotalt = 0;
    for (const k of kjop ?? []) {
      let beste = [], feil = null;
      try {
        await sleep(260);
        const vedlegg = await fiken(`/companies/${slug}/purchases/${k.kjop_id}/attachments`);
        for (const v of vedlegg) {
          if (!v.downloadUrl) continue;
          await sleep(260);
          const { buf, type } = await fiken(v.downloadUrl, true);
          if (!/pdf/i.test(type)) continue;
          try {
            const linjer = await lesFaktura(buf, getDocumentProxy);
            if (linjer.length > beste.length) beste = linjer;
          } catch (e) { feil = "PDF: " + (e?.message ?? e); }
        }
      } catch (e) { feil = String(e?.message ?? e); }

      if (beste.length) {
        await db.from("fiken_varelinje").delete().eq("kjop_id", k.kjop_id);
        const { error: e2 } = await db.from("fiken_varelinje").insert(beste.map((l, i) => ({
          kjop_id: k.kjop_id, linje: i, dato: k.dato, leverandor: k.leverandor,
          varenr: l.varenr, navn: l.navn, antall: l.antall, enhet: l.enhet, enhetspris: l.enhetspris, belop: l.belop,
        })));
        if (e2) throw e2;
      }
      await db.from("fiken_faktura_lest").upsert({ kjop_id: k.kjop_id, lest: new Date().toISOString(), linjer: beste.length, feil: beste.length ? null : (feil ?? "Fant ingen varelinjer") });
      behandlet++; linjerTotalt += beste.length;
    }
    const { data: igjen } = await db.rpc("fiken_ulest_antall");
    return svar({ ok: true, behandlet, linjer: linjerTotalt, gjenstaar: Number(igjen ?? 0) });
  } catch (e) {
    return svar({ ok: false, feil: e?.message ?? String(e) }, 500);
  }
});
