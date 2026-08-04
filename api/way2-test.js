// Vercel Serverless Function — /api/way2-test
// Proxy de teste da Way2 (credenciais só no servidor).
//
// GET/POST /api/way2-test
//   site=arm|term          (usa env WAY2_*_SDP_ID + SUBSCRIPTION_ID + KEY)
//   start=ISO              (ex.: 2025-01-01T00:00:00-03:00)
//   end=ISO
//   sdpId, subscriptionId, apiKey  (opcionais — override manual para teste)
//
// Resposta: { ok, url, status, count, totalKwh, fixoKwh, netKwh, raw }

module.exports = async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.status(405).json({ error: 'Método não permitido' });
    return;
  }

  try {
    const q = req.method === 'POST' ? (req.body || {}) : (req.query || {});
    const site = String(q.site || 'term').toLowerCase();

    const sharedKey = process.env.WAY2_KEY || '';
    const defaults =
      site === 'arm'
        ? {
            sdpId: process.env.WAY2_ARM_SDP_ID || '',
            subscriptionId: process.env.WAY2_ARM_SUBSCRIPTION_ID || '',
            apiKey: process.env.WAY2_ARM_KEY || sharedKey,
            fixo: Number(process.env.FIXO_ARM_KWH) || 0,
          }
        : {
            sdpId: process.env.WAY2_TERM_SDP_ID || '',
            subscriptionId: process.env.WAY2_TERM_SUBSCRIPTION_ID || '',
            apiKey: process.env.WAY2_TERM_KEY || sharedKey,
            fixo: Number(process.env.FIXO_TERM_KWH) || 0,
          };

    const sdpId = String(q.sdpId || defaults.sdpId || '').trim();
    const subscriptionId = String(q.subscriptionId || defaults.subscriptionId || '').trim();
    const apiKey = String(q.apiKey || defaults.apiKey || '').trim();
    const start = String(q.start || '2025-01-01T00:00:00-03:00');
    const end = String(q.end || '2025-01-31T00:00:00-03:00');
    const pageSize = Number(q.pageSize) || 500;
    const pageIndex = Number(q.pageIndex) || 1;

    if (!sdpId || !subscriptionId || !apiKey) {
      res.status(400).json({
        error:
          'Informe sdpId, subscriptionId e apiKey (ou configure WAY2_*_SDP_ID / SUBSCRIPTION_ID / KEY na Vercel).',
        site,
      });
      return;
    }

    const base = (process.env.WAY2_API_BASE || 'https://api-prod.way2.com.br').replace(/\/$/, '');
    const pathPrefix = (process.env.WAY2_PATH_PREFIX || '/measurements').replace(/\/$/, '');
    const url =
      `${base}${pathPrefix}/${encodeURIComponent(sdpId)}/energy/demand/active` +
      `?pageSize=${pageSize}&pageIndex=${pageIndex}` +
      `&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}` +
      `&orderByField=DateTime&sortDirection=ASC&origin=Telemetry`;

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
      });
      return;
    }

    if (!upstream.ok) {
      res.status(upstream.status).json({
        ok: false,
        url,
        status: upstream.status,
        raw,
      });
      return;
    }

    const items = Array.isArray(raw)
      ? raw
      : (raw?.data || raw?.items || raw?.results || raw?.measurements || []);

    let totalKwh = 0;
    let count = 0;
    for (const item of items) {
      const v =
        item.value ?? item.Value ?? item.val ?? item.demand ?? item.Demand ??
        item.activeDemand ?? item.ActiveDemand ?? item.kwh ?? null;
      const num = typeof v === 'string' ? Number(v) : v;
      if (typeof num === 'number' && !isNaN(num)) {
        totalKwh += num;
        count += 1;
      }
    }

    const fixo = Number.isFinite(defaults.fixo) && defaults.fixo > 0 ? defaults.fixo : 0;
    const netKwh = Math.max(0, totalKwh - fixo);

    res.status(200).json({
      ok: true,
      site,
      url,
      status: upstream.status,
      count,
      totalKwh,
      fixoKwh: fixo,
      netKwh,
      sampleKeys: items[0] ? Object.keys(items[0]) : [],
      raw,
    });
  } catch (err) {
    res.status(500).json({ error: String(err && err.message ? err.message : err) });
  }
};
