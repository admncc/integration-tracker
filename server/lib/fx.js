import { getSetting, setSetting } from './db.js';
import { DEFAULT_EUR_USD, FX_SETTING_KEY } from '../../shared/domain.js';

/**
 * The ECB publishes its daily euro reference rates as a small XML file, free and
 * without an API key. It is the rate both sides of an ad deal would recognise,
 * so it is what the tracker converts USD RPMs with.
 */
const ECB_DAILY = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml';

export const FX_KEYS = {
  rate: FX_SETTING_KEY,
  updatedAt: 'fx_updated_at',
  source: 'fx_source',
  auto: 'fx_auto',
  rateDate: 'fx_rate_date',
  error: 'fx_last_error',
};

/** Twelve hours: the ECB publishes once per working day around 16:00 CET. */
const REFRESH_INTERVAL_MS = 12 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;

export function fxState() {
  return {
    [FX_KEYS.rate]: Number(getSetting(FX_KEYS.rate, DEFAULT_EUR_USD)),
    updated_at: getSetting(FX_KEYS.updatedAt),
    rate_date: getSetting(FX_KEYS.rateDate),
    source: getSetting(FX_KEYS.source, 'default'),
    auto: getSetting(FX_KEYS.auto, '1') === '1',
    last_error: getSetting(FX_KEYS.error),
  };
}

/**
 * Pulls the current USD reference rate. Returns `{ ok, rate, date }` - a failure
 * is reported, never thrown, so a network blip leaves the last known rate in place.
 */
export async function fetchEcbRate() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(ECB_DAILY, { signal: controller.signal, headers: { Accept: 'application/xml' } });
    if (!response.ok) return { ok: false, error: `ECB responded with ${response.status}` };

    const xml = await response.text();
    const rate = Number(xml.match(/currency=['"]USD['"]\s+rate=['"]([\d.]+)['"]/)?.[1]);
    const date = xml.match(/time=['"](\d{4}-\d{2}-\d{2})['"]/)?.[1] ?? null;

    if (!Number.isFinite(rate) || rate <= 0) return { ok: false, error: 'No USD rate in the ECB feed' };
    return { ok: true, rate, date };
  } catch (err) {
    return { ok: false, error: err.name === 'AbortError' ? 'ECB request timed out' : String(err.message ?? err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetches and stores the rate. `force` ignores the daily-automation switch, which
 * is what the "Fetch now" button in Settings uses.
 */
export async function refreshRate({ force = false } = {}) {
  if (!force && getSetting(FX_KEYS.auto, '1') !== '1') {
    return { skipped: 'Daily updates are switched off', ...fxState() };
  }

  const result = await fetchEcbRate();
  if (!result.ok) {
    setSetting(FX_KEYS.error, result.error);
    return { error: result.error, ...fxState() };
  }

  setSetting(FX_KEYS.rate, result.rate);
  setSetting(FX_KEYS.updatedAt, new Date().toISOString());
  setSetting(FX_KEYS.rateDate, result.date ?? '');
  setSetting(FX_KEYS.source, 'ecb');
  setSetting(FX_KEYS.error, '');
  return fxState();
}

/**
 * Refreshes on boot and twice a day afterwards. The timer is unref'd so it never
 * keeps the process alive on its own.
 */
export function startDailyRefresh() {
  const run = () => {
    refreshRate().then((state) => {
      if (state.error) console.warn(`FX refresh failed: ${state.error}`);
      else if (!state.skipped) console.log(`FX rate ${state[FX_KEYS.rate]} USD/EUR (ECB ${state.rate_date})`);
    });
  };

  run();
  return setInterval(run, REFRESH_INTERVAL_MS).unref();
}
