require('dotenv').config();

const express = require('express');
const cors = require('cors');

const app = express();
const PORT = Number(process.env.PORT) || 3000;

const OPENAQ_BASE_URL = 'https://api.openaq.org/v3';
const OPENAQ_API_KEY = process.env.OPENAQ_API_KEY;

const allowedOrigins = (process.env.FLUTTER_WEB_ORIGIN || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

// ========================================
// MIDDLEWARE
// ========================================

app.use(
  cors({
    origin: (origin, callback) => {
      const isLocalhost =
        origin &&
        /^https?:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin);

      if (
        !origin ||
        allowedOrigins.includes(origin) ||
        isLocalhost
      ) {
        return callback(null, true);
      }

      return callback(new Error('Origin tidak diizinkan oleh CORS.'));
    },
  })
);

app.use(express.json());

// ========================================
// HELPER
// ========================================

async function fetchOpenAq(path, query = {}) {
  if (!OPENAQ_API_KEY) {
    const error = new Error(
      'OPENAQ_API_KEY belum dikonfigurasi di file .env.'
    );

    error.statusCode = 500;
    throw error;
  }

  const url = new URL(`${OPENAQ_BASE_URL}${path}`);

  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url, {
    headers: {
      'X-API-Key': OPENAQ_API_KEY,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    const body = await response.text();

    console.error(
      'OpenAQ HTTP Error:',
      response.status,
      body
    );

    const error = new Error(
      `OpenAQ mengembalikan HTTP ${response.status}.`
    );

    error.statusCode = 502;
    throw error;
  }

  return response.json();
}

function validatePositiveId(value, label) {
  const id = Number(value);

  if (!Number.isSafeInteger(id) || id <= 0) {
    const error = new Error(`${label} tidak valid.`);
    error.statusCode = 400;
    throw error;
  }

  return id;
}

// ========================================
// HOME
// ========================================

app.get('/', (req, res) => {
  res.json({
    message: 'AirWatch API aktif',
    endpoints: [
      '/api/locations?latitude=-6.2088&longitude=106.8456&active_hours=48',
      '/api/locations/:id/sensors',
      '/api/locations/:id/latest',
      '/api/sensors/:id',
      '/api/sensors/:id/hours?hours=48',
      '/api/sensors/:id/days?days=30',
      '/api/sensors/:id/measurements',
    ],
  });
});

// ========================================
// DAFTAR LOKASI BERDASARKAN KOORDINAT
// ========================================

app.get('/api/locations', async (req, res, next) => {
  try {
    const latitude = Number(req.query.latitude);
    const longitude = Number(req.query.longitude);
    const radius = Number(req.query.radius ?? 10000);

    if (
      req.query.latitude === undefined ||
      req.query.longitude === undefined ||
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude) ||
      latitude < -90 ||
      latitude > 90 ||
      longitude < -180 ||
      longitude > 180 ||
      !Number.isFinite(radius) ||
      radius < 1 ||
      radius > 25000
    ) {
      return res.status(400).json({
        error: 'Latitude, longitude, atau radius tidak valid.',
      });
    }

    // Opsional: buang stasiun yang sudah tidak update dalam N jam
    // terakhir, supaya aplikasi tidak memilih sensor mati.
    const activeHours =
      req.query.active_hours === undefined
        ? null
        : Number(req.query.active_hours);

    if (
      activeHours !== null &&
      (!Number.isFinite(activeHours) ||
        activeHours < 1 ||
        activeHours > 8760)
    ) {
      return res.status(400).json({
        error: 'Parameter active_hours harus berupa angka 1-8760.',
      });
    }

    const data = await fetchOpenAq('/locations', {
      coordinates: `${latitude},${longitude}`,
      radius,
      limit: 100,
      page: 1,
    });

    let results = data.results ?? [];

    if (activeHours !== null) {
      const cutoff = Date.now() - activeHours * 60 * 60 * 1000;

      results = results.filter((location) => {
        const lastUtc = location.datetimeLast?.utc;
        const lastTime = lastUtc ? new Date(lastUtc).getTime() : NaN;

        return Number.isFinite(lastTime) && lastTime >= cutoff;
      });
    }

    // Stasiun paling baru di urutan atas agar mudah dipilih di Flutter.
    results = [...results].sort((a, b) => {
      const aTime = new Date(a.datetimeLast?.utc ?? 0).getTime() || 0;
      const bTime = new Date(b.datetimeLast?.utc ?? 0).getTime() || 0;

      return bTime - aTime;
    });

    res.json({ ...data, results });
  } catch (error) {
    next(error);
  }
});

// ========================================
// DAFTAR SENSOR BERDASARKAN LOKASI
// ========================================

app.get('/api/locations/:id/sensors', async (req, res, next) => {
  try {
    const locationId = validatePositiveId(
      req.params.id,
      'Location ID'
    );

    const data = await fetchOpenAq(
      `/locations/${locationId}/sensors`,
      {
        limit: 100,
        page: 1,
      }
    );

    res.json(data);
  } catch (error) {
    next(error);
  }
});

// ========================================
// DATA TERBARU BERDASARKAN LOKASI
// ========================================

app.get('/api/locations/:id/latest', async (req, res, next) => {
  try {
    const locationId = validatePositiveId(
      req.params.id,
      'Location ID'
    );

    const data = await fetchOpenAq(
      `/locations/${locationId}/latest`,
      {
        limit: 100,
        page: 1,
      }
    );

    res.json(data);
  } catch (error) {
    next(error);
  }
});

// ========================================
// DETAIL SENSOR
// ========================================

app.get('/api/sensors/:id', async (req, res, next) => {
  try {
    const sensorId = validatePositiveId(
      req.params.id,
      'Sensor ID'
    );

    const data = await fetchOpenAq(`/sensors/${sensorId}`);

    res.json(data);
  } catch (error) {
    next(error);
  }
});

// ========================================
// DATA HISTORIS PER JAM
// Default: 48 jam terakhir
// ========================================

app.get('/api/sensors/:id/hours', async (req, res, next) => {
  try {
    const sensorId = validatePositiveId(
      req.params.id,
      'Sensor ID'
    );

    const hours = Number(req.query.hours ?? 48);

    if (
      !Number.isInteger(hours) ||
      hours < 1 ||
      hours > 720
    ) {
      return res.status(400).json({
        error: 'Parameter hours harus berupa bilangan bulat 1-720.',
      });
    }

    const rangeMs = hours * 60 * 60 * 1000;

    // Banyak sensor OpenAQ sudah berhenti mengirim data (contoh: sensor
    // 5047 terakhir update November 2016). Minta "48 jam terakhir" ke
    // sensor seperti itu selalu mengembalikan 0 baris. Jadi cek dulu
    // kapan data terakhir tersedia, lalu geser jendela waktunya.
    const detail = await fetchOpenAq(`/sensors/${sensorId}`);
    const sensor = detail.results?.[0];
    const lastUtc = sensor?.datetimeLast?.utc;
    const lastTime = lastUtc ? new Date(lastUtc).getTime() : NaN;

    const now = Date.now();
    const isStale =
      Number.isFinite(lastTime) && lastTime < now - rangeMs;

    // Untuk sensor mati, pakai jam terakhir yang ada sebagai titik akhir
    // (+1 jam agar baris terakhir ikut terambil).
    const datetimeTo = isStale
      ? new Date(lastTime + 60 * 60 * 1000)
      : new Date(now);

    const datetimeFrom = new Date(datetimeTo.getTime() - rangeMs);

    const query = {
      datetime_from: datetimeFrom.toISOString(),
      datetime_to: datetimeTo.toISOString(),
      // Satu baris per jam; batas maksimum OpenAQ adalah 1000.
      limit: Math.min(hours + 1, 1000),
      page: 1,
    };

    console.log('Sensor ID:', sensorId);
    console.log('Rentang jam:', hours);
    console.log('Data terakhir sensor:', lastUtc ?? 'tidak diketahui');
    console.log('Sensor tidak aktif:', isStale);
    console.log('Query:', query);

    const data = await fetchOpenAq(
      `/sensors/${sensorId}/hours`,
      query
    );

    console.log('Meta:', data.meta);
    console.log(
      'Jumlah data historis:',
      data.results?.length ?? 0
    );

    // Flutter perlu tahu kalau data yang tampil bukan data real-time.
    res.json({
      ...data,
      window: {
        hours,
        datetimeFrom: datetimeFrom.toISOString(),
        datetimeTo: datetimeTo.toISOString(),
        sensorDatetimeLast: lastUtc ?? null,
        isStale,
      },
    });
  } catch (error) {
    next(error);
  }
});

// ========================================
// DATA HISTORIS HARIAN
// Default: 30 hari terakhir (rata-rata per hari waktu lokal)
// Dipakai menu Riwayat di aplikasi Flutter.
// ========================================

app.get('/api/sensors/:id/days', async (req, res, next) => {
  try {
    const sensorId = validatePositiveId(
      req.params.id,
      'Sensor ID'
    );

    const days = Number(req.query.days ?? 30);

    if (!Number.isInteger(days) || days < 1 || days > 365) {
      return res.status(400).json({
        error: 'Parameter days harus berupa bilangan bulat 1-365.',
      });
    }

    const rangeMs = days * 24 * 60 * 60 * 1000;

    // Sama seperti /hours: geser jendela waktu untuk sensor mati.
    const detail = await fetchOpenAq(`/sensors/${sensorId}`);
    const sensor = detail.results?.[0];
    const lastUtc = sensor?.datetimeLast?.utc;
    const lastTime = lastUtc ? new Date(lastUtc).getTime() : NaN;

    const now = Date.now();
    const isStale =
      Number.isFinite(lastTime) && lastTime < now - rangeMs;

    const datetimeTo = isStale
      ? new Date(lastTime + 24 * 60 * 60 * 1000)
      : new Date(now);

    const datetimeFrom = new Date(datetimeTo.getTime() - rangeMs);

    const data = await fetchOpenAq(`/sensors/${sensorId}/days`, {
      datetime_from: datetimeFrom.toISOString(),
      datetime_to: datetimeTo.toISOString(),
      limit: Math.min(days + 1, 1000),
      page: 1,
    });

    console.log('Sensor ID:', sensorId);
    console.log('Rentang hari:', days);
    console.log('Jumlah data harian:', data.results?.length ?? 0);

    res.json({
      ...data,
      window: {
        days,
        datetimeFrom: datetimeFrom.toISOString(),
        datetimeTo: datetimeTo.toISOString(),
        sensorDatetimeLast: lastUtc ?? null,
        isStale,
      },
    });
  } catch (error) {
    next(error);
  }
});

// ========================================
// PENGUKURAN ASLI SENSOR
// ========================================

app.get('/api/sensors/:id/measurements', async (req, res, next) => {
  try {
    const sensorId = validatePositiveId(
      req.params.id,
      'Sensor ID'
    );

    const query = {
      limit: 100,
      page: 1,
    };

    if (req.query.datetime_from) {
      const datetimeFrom = new Date(req.query.datetime_from);

      if (Number.isNaN(datetimeFrom.getTime())) {
        return res.status(400).json({
          error: 'datetime_from tidak valid.',
        });
      }

      query.datetime_from = datetimeFrom.toISOString();
    }

    if (req.query.datetime_to) {
      const datetimeTo = new Date(req.query.datetime_to);

      if (Number.isNaN(datetimeTo.getTime())) {
        return res.status(400).json({
          error: 'datetime_to tidak valid.',
        });
      }

      query.datetime_to = datetimeTo.toISOString();
    }

    const data = await fetchOpenAq(
      `/sensors/${sensorId}/measurements`,
      query
    );

    console.log('Sensor ID:', sensorId);
    console.log('Meta pengukuran:', data.meta);
    console.log(
      'Jumlah pengukuran:',
      data.results?.length ?? 0
    );

    res.json(data);
  } catch (error) {
    next(error);
  }
});

// ========================================
// ERROR HANDLER
// ========================================

app.use((error, req, res, next) => {
  console.error('Server Error:', error.message);

  if (res.headersSent) {
    return next(error);
  }

  res.status(error.statusCode || 500).json({
    error: error.message || 'Terjadi kesalahan pada server.',
  });
});

app.get('/api/debug/sensors/:id', async (req, res, next) => {
  try {
    const sensorId = validatePositiveId(
      req.params.id,
      'Sensor ID'
    );

    const [detail, hours, measurements] = await Promise.all([
      fetchOpenAq(`/sensors/${sensorId}`),
      fetchOpenAq(`/sensors/${sensorId}/hours`, {
        limit: 10,
        page: 1,
      }),
      fetchOpenAq(`/sensors/${sensorId}/measurements`, {
        limit: 10,
        page: 1,
      }),
    ]);

    res.json({
      sensorId,
      detail: detail.results?.[0] ?? detail,
      hours: {
        meta: hours.meta,
        count: hours.results?.length ?? 0,
        sample: hours.results?.slice(0, 2) ?? [],
      },
      measurements: {
        meta: measurements.meta,
        count: measurements.results?.length ?? 0,
        sample: measurements.results?.slice(0, 2) ?? [],
      },
    });
  } catch (error) {
    next(error);
  }
});

// ========================================
// START SERVER
// ========================================

app.listen(PORT, '0.0.0.0', () => {
  console.log(`AirWatch API aktif di http://localhost:${PORT}`);
});