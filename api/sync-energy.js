// Vercel Serverless Function — /api/sync-energy
//
// Sincroniza energia ARM e TERM na Way2 — cada localidade com seu próprio
// subscriptionId + sdpId — e grava o total diário (kWh) no Firestore
// (daily/{YYYY-MM-DD}: en_arm_kwh, en_term_kwh).
//
// Endpoint Way2 (por localidade):
//   GET /measurements/{sdpId}/energy/demand/active?pageSize=&pageIndex=&start=&end=
//   Headers: subscriptionId, x-way2-key
//   (O parâmetro da doc é sdpId; o prefixo /measurements é obrigatório na API.)
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
//   Consumo fixo diário a descontar do total Way2 (kWh), antes de gravar/calcular:
//     FIXO_ARM_KWH
//     FIXO_TERM_KWH
//
//   Firebase Admin (obrigatório para gravar no Firestore):
//     FIREBASE_PROJECT_ID          (ex.: producao-f843f)
//     FIREBASE_CLIENT_EMAIL        (ex.: firebase-adminsdk-...@....iam.gserviceaccount.com)
//     FIREBASE_PRIVATE_KEY         (chave com \n; cole entre aspas na Vercel)
//   Alternativa: FIREBASE_SERVICE_ACCOUNT_JSON = JSON inteiro da service account
//
// Uso:
//   GET  /api/sync-energy
//   GET  /api/sync-energy?date=2026-07-15
//   POST /api/sync-energy { "date": "2026-07-15" }

const admin = require('firebase-admin');

const WAY2_BASE = (process.env.WAY2_API_BASE || 'https://api-prod.way2.com.br').replace(/\/$/, '');

/**
 * Normaliza private key PEM vinda de env vars da Vercel
 * (aspas extras, \\n, \n literal, espaços no lugar de quebras, etc.).
 */
function normalizePrivateKey(raw) {
  if (!raw || typeof raw !== 'string') return '';

  let key = raw.trim();

  // Remove aspas externas ("..." ou '...')
  if (
    (key.startsWith('"') && key.endsWith('"')) ||
    (key.startsWith("'") && key.endsWith("'"))
  ) {
    key = key.slice(1, -1).trim();
  }

  // Desfaz escapes comuns: \\n -> \n, depois \n literal -> newline real
  key = key
    .replace(/\\\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');

  // Se a chave veio numa linha só (espaços no lugar de newlines), reconstrói o PEM
  if (!key.includes('\n') && /BEGIN [A-Z ]*PRIVATE KEY/.test(key)) {
    key = key
      .replace(/-----BEGIN ([A-Z ]*PRIVATE KEY)-----/, '-----BEGIN $1-----\n')
      .replace(/-----END ([A-Z ]*PRIVATE KEY)-----/, '\n-----END $1-----')
      .replace(/-----BEGIN ([A-Z ]*PRIVATE KEY)-----\n\s+/, '-----BEGIN $1-----\n')
      .replace(/\s+\n-----END/, '\n-----END');

    const begin = key.match(/-----BEGIN [A-Z ]*PRIVATE KEY-----/);
    const end = key.match(/-----END [A-Z ]*PRIVATE KEY-----/);
    if (begin && end) {
      const startIdx = key.indexOf(begin[0]) + begin[0].length;
      const endIdx = key.indexOf(end[0]);
      const body = key.slice(startIdx, endIdx).replace(/\s+/g, '');
      const lines = body.match(/.{1,64}/g) || [];
      key = `${begin[0]}\n${lines.join('\n')}\n${end[0]}\n`;
    }
  }

  // Garante newline final
  if (key && !key.endsWith('\n')) key += '\n';

  if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(key) || !/-----END [A-Z ]*PRIVATE KEY-----/.test(key)) {
    throw new Error(
      'FIREBASE_PRIVATE_KEY inválida: precisa ser PEM com BEGIN/END PRIVATE KEY. ' +
      'Na Vercel, cole a chave entre aspas duplas e mantenha os \\n, ' +
      'ou use FIREBASE_SERVICE_ACCOUNT_JSON com o JSON completo da service account.'
    );
  }

  return key;
}

function resolveFirebaseCredential() {
  const jsonRaw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON || process.env.FIREBASE_SERVICE_ACCOUNT || '';
  if (jsonRaw) {
    try {
      const parsed = JSON.parse(jsonRaw);
      const projectId = parsed.project_id || parsed.projectId;
      const clientEmail = parsed.client_email || parsed.clientEmail;
      const privateKey = normalizePrivateKey(parsed.private_key || parsed.privateKey || '');
      if (!projectId || !clientEmail || !privateKey) {
        throw new Error(
          'FIREBASE_SERVICE_ACCOUNT_JSON incompleto: precisa de project_id, client_email e private_key.'
        );
      }
      return { projectId: String(projectId), clientEmail: String(clientEmail), privateKey };
    } catch (e) {
      if (e && e.message && /FIREBASE_SERVICE_ACCOUNT|PRIVATE KEY|PEM/i.test(e.message)) throw e;
      throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON inválido (não é JSON).');
    }
  }

  const projectId = (process.env.FIREBASE_PROJECT_ID || '').trim();
  const clientEmail = (process.env.FIREBASE_CLIENT_EMAIL || '').trim();
  let privateKey = '';
  try {
    privateKey = normalizePrivateKey(process.env.FIREBASE_PRIVATE_KEY || '');
  } catch (e) {
    throw e;
  }

  const missing = [];
  if (!projectId) missing.push('FIREBASE_PROJECT_ID');
  if (!clientEmail) missing.push('FIREBASE_CLIENT_EMAIL');
  if (!privateKey) missing.push('FIREBASE_PRIVATE_KEY');
  if (missing.length) {
    throw new Error(
      `Configure no projeto Vercel (dashproducao): ${missing.join(', ')}. ` +
      'Ou use FIREBASE_SERVICE_ACCOUNT_JSON com o JSON completo da service account.'
    );
  }

  return { projectId, clientEmail, privateKey };
}

function getAdmin() {
  if (!admin.apps.length) {
    const cred = resolveFirebaseCredential();
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: cred.projectId,
        clientEmail: cred.clientEmail,
        privateKey: cred.privateKey,
      }),
      projectId: cred.projectId,
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

async function fetchWay2({ sdpId, subscriptionId, apiKey, name }, startISO, endISO) {
  // Doc: GET /{sdpId}/energy/demand/active — na API real o recurso fica sob /measurements/
  const pathPrefix = (process.env.WAY2_PATH_PREFIX || '/measurements').replace(/\/$/, '');
  const url =
    `${WAY2_BASE}${pathPrefix}/${encodeURIComponent(sdpId)}/energy/demand/active` +
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
    const err = new Error(
      `Way2 ${String(name || '').toUpperCase()} respondeu ${res.status}: ${text.slice(0, 300)}`
    );
    err.url = url;
    throw err;
  }
  try {
    return { payload: JSON.parse(text), url };
  } catch (e) {
    throw new Error(`Way2 ${String(name || '').toUpperCase()} não retornou JSON válido: ${text.slice(0, 300)}`);
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

/** Soma dias a uma data YYYY-MM-DD (calendário civil, UTC). */
function addDaysYmd(ymd, days) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

/**
 * Dia operacional: 06:00 do dia D até 06:00 do dia D+1 (BRT -03:00).
 * Ex.: 2026-08-01 → 2026-08-01T06:00:00-03:00 … 2026-08-02T06:00:00-03:00
 */
function dayWindowBRT(ymd) {
  return {
    start: `${ymd}T06:00:00-03:00`,
    end: `${addDaysYmd(ymd, 1)}T06:00:00-03:00`,
  };
}

function fixedKwhForSite(siteName) {
  const raw =
    siteName === 'arm'
      ? process.env.FIXO_ARM_KWH
      : siteName === 'term'
        ? process.env.FIXO_TERM_KWH
        : '';
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Bruto Way2 − consumo fixo do dia (nunca negativo). */
function applyFixedDeduction(gross, fixo) {
  const g = Number(gross) || 0;
  const f = Number(fixo) || 0;
  return Math.max(0, g - f);
}

module.exports = async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.status(405).json({ error: 'Método não permitido' });
    return;
  }

  try {
    const body = req.method === 'POST' ? (req.body || {}) : {};
    const targetDate = body.date || req.query?.date || yesterday();

    // Dia operacional: 06:00 do dia até 06:00 do dia seguinte (BRT).
    const { start, end } = dayWindowBRT(targetDate);

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
    // O consumo fixo (FIXO_ARM_KWH / FIXO_TERM_KWH) é descontado antes de gravar.
    for (const site of sites) {
      try {
        const { payload, url } = await fetchWay2(site, start, end);
        const { total, count } = sumEnergy(payload);
        const fixo = fixedKwhForSite(site.name);
        const net = applyFixedDeduction(total, fixo);
        results[site.field] = net;
        debug[site.name] = {
          sdpId: site.sdpId,
          subscriptionId: site.subscriptionId,
          url,
          count,
          grossKwh: total,
          fixoKwh: fixo,
          netKwh: net,
        };
      } catch (err) {
        errors.push({ site: site.name, error: String(err && err.message ? err.message : err) });
        debug[site.name] = {
          sdpId: site.sdpId,
          subscriptionId: site.subscriptionId,
          url: err && err.url ? err.url : undefined,
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
      window: { start, end },
      ...results,
      debug,
      ...(errors.length ? { partialErrors: errors } : {}),
    });
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    const isConfig = /Configure|FIREBASE_|inválido|incompleto|PRIVATE KEY|PEM/i.test(msg);
    res.status(isConfig ? 400 : 500).json({ error: msg });
  }
};
