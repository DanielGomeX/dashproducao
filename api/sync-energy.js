// Vercel Serverless Function — /api/sync-energy
//
// Sincroniza energia ARM e TERM na Way2 — cada localidade com seu próprio
// subscriptionId + sdpId — e grava o total diário (kWh) no Firestore
// (daily/{YYYY-MM-DD}: en_arm_kwh, en_term_kwh).
//
// Endpoint Way2 (por localidade):
//   GET /{sdpId}/energy/demand/active?pageSize=&pageIndex=&start=&end=
//   Headers: subscriptionId, x-way2-key
//
// Variáveis de ambiente (Vercel) — configure as duas localidades:
//
//   ARM:
//     WAY2_ARM_SUBSCRIPTION_ID
//     WAY2_ARM_SDP_ID
//     WAY2_ARM_KEY              (opcional; senão usa WAY2_KEY)
//
//   TERM:
//     WAY2_TERM_SUBSCRIPTION_ID
//     WAY2_TERM_SDP_ID
//     WAY2_TERM_KEY             (opcional; senão usa WAY2_KEY)
//
//   Compartilhado (se as keys forem iguais):
//     WAY2_KEY
//
//   Firebase Admin:
//     FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY
//
// Uso:
//   GET  /api/sync-energy
//   GET  /api/sync-energy?date=2026-07-15
//   POST /api/sync-energy { "date": "2026-07-15" }

const admin = require('firebase-admin');

const WAY2_BASE = (process.env.WAY2_API_BASE || 'https://api-prod.way2.com.br').replace(/\/$/, '');

function getAdmin() {
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
      }),
    });
  }
  return admin;
}

/** Credenciais por localidade (ARM / TERM). */
function resolveSites() {
  const sharedKey = process.env.WAY2_KEY || '';

  const sites = [
    {
      name: 'arm',
      field: 'en_arm_kwh',
      subscriptionId: process.env.WAY2_ARM_SUBSCRIPTION_ID || '',
      sdpId: process.env.WAY2_ARM_SDP_ID || '',
      apiKey: process.env.WAY2_ARM_KEY || sharedKey,
    },
    {
      name: 'term',
      field: 'en_term_kwh',
      subscriptionId: process.env.WAY2_TERM_SUBSCRIPTION_ID || '',
      sdpId: process.env.WAY2_TERM_SDP_ID || '',
      apiKey: process.env.WAY2_TERM_KEY || sharedKey,
    },
  ];

  return sites.filter((s) => s.subscriptionId && s.sdpId);
}

function missingSiteConfig() {
  const missing = [];
  if (!process.env.WAY2_ARM_SUBSCRIPTION_ID || !process.env.WAY2_ARM_SDP_ID) {
    missing.push('ARM (WAY2_ARM_SUBSCRIPTION_ID + WAY2_ARM_SDP_ID)');
  }
  if (!process.env.WAY2_TERM_SUBSCRIPTION_ID || !process.env.WAY2_TERM_SDP_ID) {
    missing.push('TERM (WAY2_TERM_SUBSCRIPTION_ID + WAY2_TERM_SDP_ID)');
  }
  return missing;
}

async function fetchWay2({ sdpId, subscriptionId, apiKey }, startISO, endISO) {
  const url =
    `${WAY2_BASE}/${encodeURIComponent(sdpId)}/energy/demand/active` +
    `?pageSize=500&pageIndex=1&start=${encodeURIComponent(startISO)}&end=${encodeURIComponent(endISO)}` +
    `&orderByField=DateTime&sortDirection=ASC&origin=Telemetry`;

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      subscriptionId,
      'Cache-Control': 'no-cache',
      'x-way2-key': apiKey,
    },
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Way2 (${sdpId}) respondeu ${res.status}: ${text.slice(0, 300)}`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`Way2 (${sdpId}) não retornou JSON válido: ${text.slice(0, 300)}`);
  }
}

function sumEnergy(payload) {
  const items = Array.isArray(payload)
    ? payload
    : (payload?.data || payload?.items || payload?.results || payload?.measurements || []);

  let total = 0;
  let count = 0;
  for (const item of items) {
    const raw =
      item.value ?? item.Value ?? item.val ?? item.demand ?? item.Demand ??
      item.activeDemand ?? item.ActiveDemand ?? item.kwh ?? null;
    const num = typeof raw === 'string' ? Number(raw) : raw;
    if (typeof num === 'number' && !isNaN(num)) {
      total += num;
      count += 1;
    }
  }
  return { total, count };
}

function yesterday() {
  const d = new Date(Date.now() - 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

module.exports = async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.status(405).json({ error: 'Método não permitido' });
    return;
  }

  try {
    const body = req.method === 'POST' ? (req.body || {}) : {};
    const targetDate = body.date || req.query?.date || yesterday();

    const start = `${targetDate}T00:00:00-03:00`;
    const nextDay = new Date(new Date(`${targetDate}T00:00:00-03:00`).getTime() + 24 * 60 * 60 * 1000)
      .toISOString().slice(0, 10);
    const end = `${nextDay}T00:00:00-03:00`;

    const sites = resolveSites();
    if (!sites.length) {
      res.status(400).json({
        error:
          'Configure ARM e/ou TERM com subscriptionId + sdpId próprios. ' +
          'Faltando: ' + missingSiteConfig().join('; ') + '.',
      });
      return;
    }

    for (const site of sites) {
      if (!site.apiKey) {
        res.status(400).json({
          error: `Configure WAY2_${site.name.toUpperCase()}_KEY ou WAY2_KEY para a localidade ${site.name.toUpperCase()}.`,
        });
        return;
      }
    }

    const results = {};
    const debug = {};
    const errors = [];

    // Cada localidade é consultada com o seu próprio subscriptionId + sdpId.
    for (const site of sites) {
      try {
        const payload = await fetchWay2(site, start, end);
        const { total, count } = sumEnergy(payload);
        results[site.field] = total;
        debug[site.name] = {
          sdpId: site.sdpId,
          subscriptionId: site.subscriptionId,
          count,
        };
      } catch (err) {
        errors.push({ site: site.name, error: String(err && err.message ? err.message : err) });
        debug[site.name] = {
          sdpId: site.sdpId,
          subscriptionId: site.subscriptionId,
          error: String(err && err.message ? err.message : err),
        };
      }
    }

    if (!Object.keys(results).length) {
      res.status(502).json({
        error: 'Nenhuma localidade retornou dados da Way2.',
        debug,
        errors,
      });
      return;
    }

    const fsAdmin = getAdmin();
    await fsAdmin.firestore().collection('daily').doc(targetDate).set(
      { ...results, energySyncedAt: new Date().toISOString() },
      { merge: true }
    );

    res.status(200).json({
      ok: true,
      date: targetDate,
      ...results,
      debug,
      ...(errors.length ? { partialErrors: errors } : {}),
    });
  } catch (err) {
    res.status(500).json({ error: String(err && err.message ? err.message : err) });
  }
};
