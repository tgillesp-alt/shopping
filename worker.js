const VAPID_PUBLIC = 'BBugd5BD_AJbVUv9lfD-2tfp3apULExDnMQ8xVQZ9oUMmG8nUXwG-ADhCojwp4DDMI3XybLCIBe_951RA5_PHUs';
// VAPID_PRIVATE loaded from Cloudflare environment secret
const VAPID_SUBJECT = 'mailto:thomas@fagerbistro.no';
const SUPABASE_URL = 'https://izdclsyuplghwznsjnom.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml6ZGNsc3l1cGxnaHd6bnNqbm9tIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE1MjY5MjksImV4cCI6MjA5NzEwMjkyOX0.GkjxcToCHZrLAm1pVGsBkcLapIOj7uSYd6IcDC0Lyzk';

const DRIKKE_KATEGORIER = ['Vin', 'Øl', 'Mineralvann', 'Sprit'];

function base64UrlToUint8Array(base64Url) {
  const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

function uint8ArrayToBase64Url(arr) {
  return btoa(String.fromCharCode(...arr)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function getVapidAuthHeader(audience, vapidPrivate) {
  const header = { alg: 'ES256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const payload = { aud: audience, exp: now + 3600, sub: VAPID_SUBJECT };
  const enc = txt => uint8ArrayToBase64Url(new TextEncoder().encode(txt));
  const signingInput = `${enc(JSON.stringify(header))}.${enc(JSON.stringify(payload))}`;
  const keyData = base64UrlToUint8Array(vapidPrivate);
  const key = await crypto.subtle.importKey('raw', keyData, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const privateKey = await crypto.subtle.importKey(
    'pkcs8',
    await crypto.subtle.exportKey('pkcs8', key).catch(() => { throw new Error('key export failed'); }),
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, new TextEncoder().encode(signingInput));
  return `vapid t=${signingInput}.${uint8ArrayToBase64Url(new Uint8Array(sig))},k=${VAPID_PUBLIC}`;
}

async function sendPush(subscription, payload, vapidPrivate) {
  const url = new URL(subscription.endpoint);
  const audience = `${url.protocol}//${url.host}`;
  try {
    const auth = await getVapidAuthHeader(audience, vapidPrivate);
    await fetch(subscription.endpoint, {
      method: 'POST',
      headers: {
        'Authorization': auth,
        'Content-Type': 'application/octet-stream',
        'Content-Encoding': 'aes128gcm',
        'TTL': '86400',
      },
      body: new TextEncoder().encode(JSON.stringify(payload)),
    });
  } catch (e) {
    console.error('Push failed:', e);
  }
}

async function getSubscriptions() {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/push_subscriptions?select=*`, {
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
  });
  return res.json();
}

export default {
  async fetch(request, env) {
    const VAPID_PRIVATE = env.VAPID_PRIVATE;
    const url = new URL(request.url);
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    if (url.pathname === '/subscribe' && request.method === 'POST') {
      const body = await request.json();
      await fetch(`${SUPABASE_URL}/rest/v1/push_subscriptions`, {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal',
        },
        body: JSON.stringify({ endpoint: body.endpoint, keys: body.keys, bruker: body.bruker }),
      });
      return new Response('OK', { headers: cors });
    }

    if (url.pathname === '/notify' && request.method === 'POST') {
      const body = await request.json();
      const subs = await getSubscriptions();
      const erDrikke = DRIKKE_KATEGORIER.includes(body.kategori);

      for (const sub of subs) {
        if (sub.bruker === body.fra) continue;

        const skalVarsles = erDrikke
          ? sub.bruker === 'Christine'
          : ['Thomas', 'Marcus'].includes(sub.bruker);

        if (skalVarsles) {
          await sendPush({ endpoint: sub.endpoint, keys: sub.keys }, {
            title: 'Fager Bistro – Shopping',
            body: `${body.fra} la til: ${body.vare}`,
          }, VAPID_PRIVATE);
        }
      }
      return new Response('OK', { headers: cors });
    }

    return new Response('Not found', { status: 404, headers: cors });
  }
};
