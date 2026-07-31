// Vercel Serverless Function — /api/sync-energy
//
// Busca o consumo de energia (ARM e/ou TERM) na API da Way2 e grava o total
// diário (kWh) no Firestore, no documento daily/{YYYY-MM-DD}.
//
// As credenciais (Way2 e Firebase Admin) NUNCA ficam no HTML — só aqui,
// como variáveis de ambiente do projeto na Vercel. Veja o guia de
// configuração (SETUP.md) para a lista completa de variáveis.
//
// Uso:
//   GET  /api/sync-energy                -> sincroniza o dia de ONTEM (uso pelo cron)
//   GET  /api/sync-energy?date=2026-07-15 -> sincroniza uma data específica
//   POST /api/sync-energy { "date": "2026-07-15" } -> idem, via botão do dashboard

const admin = require('firebase-admin');

function getAdmin() {
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        // No painel da Vercel, quebras de linha da chave privada viram "\n" literal;
        // aqui convertemos de volta para quebras de linha reais.
        privateKey: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
      }),
    });
  }
  return admin;
}

async function fetchWay2(measurementId, startISO, endISO) {
  const url =
    `https://api-prod.way2.com.br/measurements/${measurementId}/energy/demand/active` +
    `?pageSize=500&pageIndex=1&start=${encodeURIComponent(startISO)}&end=${encodeURIComponent(endISO)}` +
    `&orderByField=DateTime&sortDirection=ASC&origin=Telemetry`;

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      subscriptionId: process.env.WAY2_SUBSCRIPTION_ID,
      'Cache-Control': 'no-cache',
      'x-way2-key': process.env.WAY2_KEY,
    },
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Way2 API respondeu ${res.status}: ${text.slice(0, 300)}`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`Resposta da Way2 não é JSON válido: ${text.slice(0, 300)}`);
  }
}

// A Way2 pode devolver formatos diferentes (array direto, ou { data: [...] } / { items: [...] }).
// Tentamos cobrir os casos mais comuns. IMPORTANTE: confira o nome real do campo de valor
// no payload de resposta e ajuste a lista abaixo se necessário (ex.: "activeDemand", "kwh").
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

    if (!process.env.WAY2_SUBSCRIPTION_ID || !process.env.WAY2_KEY) {
      res.status(400).json({ error: 'Configure WAY2_SUBSCRIPTION_ID e WAY2_KEY nas variáveis de ambiente da Vercel.' });
      return;
    }

    const results = {};
    const raw = {};

    if (process.env.WAY2_MEASUREMENT_ARM) {
      const payload = await fetchWay2(process.env.WAY2_MEASUREMENT_ARM, start, end);
      const { total, count } = sumEnergy(payload);
      results.en_arm_kwh = total;
      raw.arm = { count };
    }
    if (process.env.WAY2_MEASUREMENT_TERM) {
      const payload = await fetchWay2(process.env.WAY2_MEASUREMENT_TERM, start, end);
      const { total, count } = sumEnergy(payload);
      results.en_term_kwh = total;
      raw.term = { count };
    }

    if (!Object.keys(results).length) {
      res.status(400).json({ error: 'Configure WAY2_MEASUREMENT_ARM e/ou WAY2_MEASUREMENT_TERM nas variáveis de ambiente.' });
      return;
    }

    const fsAdmin = getAdmin();
    await fsAdmin.firestore().collection('daily').doc(targetDate).set(
      { ...results, energySyncedAt: new Date().toISOString() },
      { merge: true }
    );

    res.status(200).json({ ok: true, date: targetDate, ...results, debug: raw });
  } catch (err) {
    res.status(500).json({ error: String(err && err.message ? err.message : err) });
  }
};
