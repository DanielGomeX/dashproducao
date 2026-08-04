// Vercel Serverless Function — /api/way2-test
// Proxy de teste da Way2 — consumo total ativo.
//
// Endpoint:
//   GET /measurements/{sdpId}/energy/total-consumption/active
//       ?start=...&end=...&origin=Telemetry
// Resposta Way2: { "consumptionValue": 60918.2 }
//
// Body/query:
//   site=arm|term
//   date=YYYY-MM-DD  OU  start/end ISO  OU  startDate/endDate
//   fixoKwh=number   (override; senão FIXO_ARM_KWH / FIXO_TERM_KWH)
//   sdpId, subscriptionId, apiKey (override opcional)

function parseFixo(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return 0;
  const n = Number(String(raw).trim().replace(',', '.'));
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function addDaysYmd(ymd, days) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

/** Início do dia operacional (06:00). */
function isoStart(ymd) {
  return `${ymd}T06:00:00-03`;
}

/** Fim no calendário ymd = 05:59:59 desse dia. */
function isoEnd(ymd) {
  return `${ymd}T05:59:59-03`;
}

/** Fim do dia operacional que começa em ymd (amanhã 05:59:59). */
function isoEndNextDay(ymd) {
  return isoEnd(addDaysYmd(ymd, 1));
}

module.exports = async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.status(405).json({ error: 'Método não permitido' });
    return;
  }

  try {
    const q = req.method === 'POST' ? (req.body || {}) : (req.query || {});
    const site = String(q.site || 'arm').toLowerCase();

    const sharedKey = process.env.WAY2_KEY || '';
    const envFixoArm = parseFixo(process.env.FIXO_ARM_KWH);
    const envFixoTerm = parseFixo(process.env.FIXO_TERM_KWH);

    const defaults =
      site === 'arm'
        ? {
            sdpId: process.env.WAY2_ARM_SDP_ID || '',
            subscriptionId: process.env.WAY2_ARM_SUBSCRIPTION_ID || '',
            apiKey: process.env.WAY2_ARM_KEY || sharedKey,
            fixo: envFixoArm,
          }
        : {
            sdpId: process.env.WAY2_TERM_SDP_ID || '',
            subscriptionId: process.env.WAY2_TERM_SUBSCRIPTION_ID || '',
            apiKey: process.env.WAY2_TERM_KEY || sharedKey,
            fixo: envFixoTerm,
          };

    const sdpId = String(q.sdpId || defaults.sdpId || '').trim();
    const subscriptionId = String(q.subscriptionId || defaults.subscriptionId || '').trim();
    const apiKey = String(q.apiKey || defaults.apiKey || '').trim();

    // fixo: override do body tem prioridade; senão env da localidade
    const fixo =
      q.fixoKwh !== undefined && q.fixoKwh !== null && String(q.fixoKwh).trim() !== ''
        ? parseFixo(q.fixoKwh)
        : defaults.fixo;

    let start;
    let end;
    if (q.start && q.end) {
      start = String(q.start);
      end = String(q.end);
    } else if (q.date) {
      const ymd = String(q.date).slice(0, 10);
      start = isoStart(ymd);
      end = isoEndNextDay(ymd);
    } else if (q.startDate) {
      const s = String(q.startDate).slice(0, 10);
      const e = String(q.endDate || addDaysYmd(s, 1)).slice(0, 10);
      start = isoStart(s);
      // endDate = manhã do dia seguinte (calendário) → 05:59:59 desse dia
      end = isoEnd(e);
    } else {
      start = isoStart('2026-08-01');
      end = isoEndNextDay('2026-08-01');
    }

    if (!sdpId || !subscriptionId || !apiKey) {
      res.status(400).json({
        error:
          'Informe sdpId, subscriptionId e apiKey (ou configure WAY2_*_SDP_ID / SUBSCRIPTION_ID / KEY na Vercel).',
        site,
        envFixo: { arm: envFixoArm, term: envFixoTerm },
      });
      return;
    }

    const base = (process.env.WAY2_API_BASE || 'https://api-prod.way2.com.br').replace(/\/$/, '');
    const pathPrefix = (process.env.WAY2_PATH_PREFIX || '/measurements').replace(/\/$/, '');
    const url =
      `${base}${pathPrefix}/${encodeURIComponent(sdpId)}/energy/total-consumption/active` +
      `?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&origin=Telemetry`;

    const upstream = await fetch(url, {
      method: 'GET',
      headers: {
        subscriptionId,
        'Cache-Control': 'no-cache',
        'x-way2-key': apiKey,
      },
    });

    const text = await upstream.text();
    let raw;
    try {
      raw = JSON.parse(text);
    } catch (_) {
      res.status(upstream.ok ? 502 : upstream.status).json({
        ok: false,
        url,
        status: upstream.status,
        error: 'Resposta Way2 não é JSON',
        bodyPreview: text.slice(0, 800),
        envFixo: { arm: envFixoArm, term: envFixoTerm },
      });
      return;
    }

    if (!upstream.ok) {
      res.status(upstream.status).json({
        ok: false,
        url,
        status: upstream.status,
        raw,
        envFixo: { arm: envFixoArm, term: envFixoTerm },
      });
      return;
    }

    // Formato esperado: { consumptionValue: number }
    const consumption =
      raw?.consumptionValue ?? raw?.ConsumptionValue ?? raw?.value ?? null;
    const totalKwh = typeof consumption === 'string' ? Number(consumption) : Number(consumption);
    if (!Number.isFinite(totalKwh)) {
      res.status(502).json({
        ok: false,
        url,
        status: upstream.status,
        error: 'Campo consumptionValue ausente ou inválido na resposta Way2.',
        raw,
        envFixo: { arm: envFixoArm, term: envFixoTerm },
      });
      return;
    }

    const netKwh = Math.max(0, totalKwh - fixo);

    res.status(200).json({
      ok: true,
      site,
      url,
      status: upstream.status,
      window: { start, end },
      consumptionValue: totalKwh,
      totalKwh,
      fixoKwh: fixo,
      netKwh,
      envFixo: { arm: envFixoArm, term: envFixoTerm },
      fixoSource:
        q.fixoKwh !== undefined && q.fixoKwh !== null && String(q.fixoKwh).trim() !== ''
          ? 'override'
          : site === 'arm'
            ? 'FIXO_ARM_KWH'
            : 'FIXO_TERM_KWH',
      raw,
    });
  } catch (err) {
    res.status(500).json({ error: String(err && err.message ? err.message : err) });
  }
};
