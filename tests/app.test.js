import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { extractStatement, parseChargeCents } from '../src/statement.js';
import { groupPassJourneys, summarize } from '../src/fares.js';

test('extracts the August statement fixture', async () => {
  const bytes = new Uint8Array(await readFile('examples/ltafaresaug.PDF'));
  const statement = await extractStatement(bytes);

  assert.equal(statement.transactions.length, 94);
  assert.equal(statement.transactions.filter(({ mode }) => mode === 'bus').length, 43);
  assert.equal(statement.transactions.filter(({ mode }) => mode === 'train').length, 51);
  assert.equal(statement.transactions.filter(({ chargeKind }) => chargeKind === 'pass').length, 94);
  assert.equal(statement.periodStart, '2026-08-01');
  assert.equal(statement.periodEnd, '2026-08-31');
  assert.equal(statement.cardLabel, 'SAF PASSION CARD');
  assert.equal(statement.cardLast4, '3620');
  assert.deepEqual(statement.warnings, []);
});

function passLeg(
  id,
  occurredAt,
  mode,
  origin,
  destination,
  distanceKm,
  service = mode === 'bus' ? '1' : 'Train',
) {
  return {
    id,
    occurredAt,
    mode,
    service,
    origin,
    destination,
    chargeKind: 'pass',
    chargedCents: 0,
    rawCharge: 'Pass Usage',
    journeyId: null,
    distanceKm,
    estimatedCents: null,
    estimateStatus: 'estimated',
    estimateReason: null,
  };
}

test('groups official transfers and totals exact cents', () => {
  const bus = passLeg('bus', '2026-08-01T08:00:00+08:00', 'bus', 'Origin', 'Central', 2);
  const train = passLeg('train', '2026-08-01T08:20:00+08:00', 'train', 'Central', 'Destination', 5);
  const joined = groupPassJourneys([bus, train]);

  assert.equal(new Set(joined.map(({ journeyId }) => journeyId)).size, 1);
  assert.deepEqual(joined.map(({ estimatedCents }) => estimatedCents), [128, 40]);
  assert.equal(summarize(joined).estimatedPassCents, 168);

  const split = groupPassJourneys([
    bus,
    { ...train, occurredAt: '2026-08-01T08:46:00+08:00' },
  ]);
  assert.equal(new Set(split.map(({ journeyId }) => journeyId)).size, 2);
  assert.equal(summarize(split).estimatedPassCents, 277);

  const moneyRow = {
    ...bus,
    id: 'money',
    chargeKind: 'money',
    rawCharge: '$ 1.38',
    chargedCents: parseChargeCents('$ 1.38'),
  };
  assert.equal(moneyRow.chargedCents, 138);
  assert.equal(summarize([moneyRow]).chargedCents, 138);
});

test('enforces every official journey boundary', () => {
  const bus = passLeg('bus', '2026-08-01T08:00:00+08:00', 'bus', 'A', 'B', 2, '98');
  const otherBus = passLeg('other-bus', '2026-08-01T08:45:00+08:00', 'bus', 'C', 'D', 2, '99');
  assert.equal(new Set(groupPassJourneys([bus, otherBus]).map(({ journeyId }) => journeyId)).size, 1);
  assert.equal(new Set(groupPassJourneys([
    bus,
    { ...otherBus, service: '98A' },
  ]).map(({ journeyId }) => journeyId)).size, 2);

  const firstTrain = passLeg('train-1', '2026-08-01T08:00:00+08:00', 'train', 'A', 'Central', 2);
  const secondTrain = passLeg('train-2', '2026-08-01T08:15:00+08:00', 'train', 'Other', 'D', 2);
  assert.equal(new Set(groupPassJourneys([firstTrain, secondTrain]).map(({ journeyId }) => journeyId)).size, 1);
  assert.equal(new Set(groupPassJourneys([
    firstTrain,
    { ...secondTrain, occurredAt: '2026-08-01T08:16:00+08:00' },
  ]).map(({ journeyId }) => journeyId)).size, 2);
  assert.equal(new Set(groupPassJourneys([
    firstTrain,
    { ...secondTrain, origin: 'Central Stn Exit A' },
  ]).map(({ journeyId }) => journeyId)).size, 2);
  assert.equal(new Set(groupPassJourneys([
    firstTrain,
    passLeg('interposed-bus', '2026-08-01T08:30:00+08:00', 'bus', 'E', 'F', 2, '99'),
    { ...secondTrain, occurredAt: '2026-08-01T09:00:00+08:00', origin: 'Central' },
  ]).map(({ journeyId }) => journeyId)).size, 2);

  const twoHourJourney = [
    passLeg('two-hour-1', '2026-08-01T08:00:00+08:00', 'bus', 'A', 'B', 1, '10'),
    passLeg('two-hour-2', '2026-08-01T08:40:00+08:00', 'train', 'C', 'D', 1),
    passLeg('two-hour-3', '2026-08-01T09:20:00+08:00', 'bus', 'E', 'F', 1, '11'),
    passLeg('two-hour-4', '2026-08-01T10:00:00+08:00', 'train', 'G', 'H', 1),
  ];
  assert.equal(new Set(groupPassJourneys(twoHourJourney).map(({ journeyId }) => journeyId)).size, 1);
  assert.equal(new Set(groupPassJourneys([
    ...twoHourJourney.slice(0, -1),
    { ...twoHourJourney.at(-1), occurredAt: '2026-08-01T10:01:00+08:00' },
  ]).map(({ journeyId }) => journeyId)).size, 2);

  const sevenLegs = [
    passLeg('leg-1', '2026-08-01T08:00:00+08:00', 'bus', 'A', 'B', 1, '10'),
    passLeg('leg-2', '2026-08-01T08:10:00+08:00', 'train', 'C', 'D', 1),
    passLeg('leg-3', '2026-08-01T08:20:00+08:00', 'bus', 'E', 'F', 1, '11'),
    passLeg('leg-4', '2026-08-01T08:30:00+08:00', 'train', 'G', 'H', 1),
    passLeg('leg-5', '2026-08-01T08:40:00+08:00', 'bus', 'I', 'J', 1, '12'),
    passLeg('leg-6', '2026-08-01T08:50:00+08:00', 'train', 'K', 'L', 1),
    passLeg('leg-7', '2026-08-01T09:00:00+08:00', 'bus', 'M', 'N', 1, '13'),
  ];
  const groupedSevenLegs = groupPassJourneys(sevenLegs);
  assert.equal(new Set(groupedSevenLegs.map(({ journeyId }) => journeyId)).size, 2);
  assert.equal(new Set(groupedSevenLegs.slice(0, 6).map(({ journeyId }) => journeyId)).size, 1);
  assert.notEqual(groupedSevenLegs[5].journeyId, groupedSevenLegs[6].journeyId);
});
