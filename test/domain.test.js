import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rpmUplift, siteCompletion, toBase, formatMoney } from '../shared/domain.js';

test('toBase leaves EUR alone and divides USD by the rate', () => {
  assert.equal(toBase(5, 'EUR', 1.1662), 5);
  assert.equal(toBase(5.83, 'USD', 1.1662).toFixed(2), '5.00');
});

test('toBase reports missing figures as null rather than zero', () => {
  assert.equal(toBase(null, 'EUR'), null);
  assert.equal(toBase('', 'EUR'), null);
  assert.equal(toBase('not a number', 'EUR'), null);
});

test('toBase falls back to the default rate when the stored one is unusable', () => {
  assert.equal(toBase(1.08, 'USD', 0), 1);
  assert.equal(toBase(1.08, 'USD', -3), 1);
});

test('rpmUplift compares two currencies through the rate', () => {
  // $5.80 is €5.00 at 1.16; against €6.00 that is a 20% gain.
  const uplift = rpmUplift({ rpm_previous: 5.8, rpm_previous_currency: 'USD', rpm_primis: 6, rpm_primis_currency: 'EUR' }, 1.16);
  assert.equal(uplift.toFixed(1), '20.0');
});

test('rpmUplift is negative when Primis earns less than the previous setup', () => {
  const uplift = rpmUplift({ rpm_previous: 4, rpm_previous_currency: 'EUR', rpm_primis: 3, rpm_primis_currency: 'EUR' }, 1.16);
  assert.equal(uplift, -25);
});

test('rpmUplift stays null when a figure is missing or the base is zero', () => {
  assert.equal(rpmUplift({ rpm_previous: 4, rpm_primis: null }, 1.16), null);
  assert.equal(rpmUplift({ rpm_previous: null, rpm_primis: 4 }, 1.16), null);
  assert.equal(rpmUplift({ rpm_previous: 0, rpm_primis: 4 }, 1.16), null);
});

test('formatMoney renders the currency it is given', () => {
  assert.match(formatMoney(3.13, 'EUR'), /3,13/);
  assert.match(formatMoney(2, 'USD'), /2,00/);
  assert.equal(formatMoney(null, 'EUR'), '');
});

test('siteCompletion counts live and n/a tracks as done', () => {
  const allLive = {
    status_video: 'live', status_display: 'live', status_ads_txt: 'live', status_ad_tag: 'live', status_mcm: 'live',
  };
  assert.equal(siteCompletion(allLive), 100);
  assert.equal(siteCompletion({ ...allLive, status_display: 'pending' }), 80);
  assert.equal(siteCompletion({ ...allLive, status_video: 'na' }), 100);
});
