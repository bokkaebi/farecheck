import { samePlace } from './transit.js';

export const FARE_EFFECTIVE_DATE = '2025-12-27';
const MAX_JOURNEY_MINUTES = 120;
const MAX_TRANSFERS = 5;
const BUS_TRANSFER_MINUTES = 45;
const TRAIN_TRANSFER_MINUTES = 15;

const ADULT_CARD_FARES = [
  [3.2, 128],
  [4.2, 138],
  [5.2, 149],
  [6.2, 159],
  [7.2, 168],
  [8.2, 175],
  [9.2, 182],
  [10.2, 186],
  [11.2, 190],
  [12.2, 194],
  [13.2, 198],
  [14.2, 202],
  [15.2, 207],
  [16.2, 211],
  [17.2, 215],
  [18.2, 220],
  [19.2, 224],
  [20.2, 227],
  [21.2, 230],
  [22.2, 233],
  [23.2, 236],
  [24.2, 238],
  [25.2, 240],
  [26.2, 242],
  [27.2, 243],
  [28.2, 244],
  [29.2, 245],
  [30.2, 246],
  [31.2, 247],
  [32.2, 248],
  [33.2, 249],
  [34.2, 250],
  [35.2, 251],
  [36.2, 252],
  [37.2, 253],
  [38.2, 254],
  [39.2, 255],
  [40.2, 256],
];

export function fareForDistance(km) {
  return ADULT_CARD_FARES.find(([ceiling]) => km <= ceiling)?.[1] ?? 257;
}

function busServiceFamily(service) {
  return String(service).match(/^\d+/)?.[0] ?? String(service).toLowerCase();
}

function canJoin(journey, next) {
  const previous = journey.at(-1);
  if (!previous || previous.chargeKind !== 'pass' || next.chargeKind !== 'pass') return false;
  if (journey.length > MAX_TRANSFERS) return false;

  const firstToNextMinutes = (
    Date.parse(next.occurredAt) - Date.parse(journey[0].occurredAt)
  ) / 60_000;
  if (firstToNextMinutes < 0 || firstToNextMinutes > MAX_JOURNEY_MINUTES) return false;

  const transferMinutes = (
    Date.parse(next.occurredAt) - Date.parse(previous.occurredAt)
  ) / 60_000;
  if (transferMinutes < 0) return false;

  if (
    next.mode === 'train'
    && journey.some((leg) => (
      leg.mode === 'train' && samePlace(leg.destination, next.origin)
    ))
  ) {
    return false;
  }
  if (previous.mode === 'train' && next.mode === 'train') {
    return transferMinutes <= TRAIN_TRANSFER_MINUTES;
  }
  if (
    previous.mode === 'bus'
    && next.mode === 'bus'
    && busServiceFamily(previous.service) === busServiceFamily(next.service)
  ) {
    return false;
  }
  return transferMinutes <= BUS_TRANSFER_MINUTES;
}

export function groupPassJourneys(transactions) {
  const chronological = transactions
    .map((transaction, index) => ({ ...transaction, originalIndex: index }))
    .sort((left, right) => Date.parse(left.occurredAt) - Date.parse(right.occurredAt));
  const journeys = [];
  let currentJourney = null;

  for (const transaction of chronological) {
    if (transaction.chargeKind !== 'pass') {
      currentJourney = null;
      continue;
    }
    if (!currentJourney || !canJoin(currentJourney, transaction)) {
      currentJourney = [];
      journeys.push(currentJourney);
    }
    currentJourney.push(transaction);
  }

  journeys.forEach((legs, journeyIndex) => {
    const journeyId = `journey-${journeyIndex + 1}`;
    const historical = legs.some((leg) => leg.occurredAt.slice(0, 10) < FARE_EFFECTIVE_DATE);
    const unresolved = legs.some((leg) => (
      leg.estimateStatus !== 'estimated' || !Number.isFinite(leg.distanceKm)
    ));

    if (historical || unresolved) {
      for (const leg of legs) {
        leg.journeyId = journeyId;
        leg.estimatedCents = null;
        leg.estimateStatus = 'unavailable';
        leg.estimateReason = historical
          ? 'No fare table for this date'
          : leg.estimateReason ?? 'Journey includes an unresolved leg';
      }
      return;
    }

    let cumulativeKm = 0;
    let cumulativeFare = 0;
    for (const leg of legs) {
      cumulativeKm += leg.distanceKm;
      const newFare = fareForDistance(cumulativeKm);
      leg.journeyId = journeyId;
      leg.estimatedCents = newFare - cumulativeFare;
      leg.estimateStatus = 'estimated';
      leg.estimateReason = null;
      cumulativeFare = newFare;
    }
  });

  return chronological
    .sort((left, right) => left.originalIndex - right.originalIndex)
    .map(({ originalIndex, ...transaction }) => transaction);
}

export function summarize(transactions) {
  return transactions.reduce((summary, transaction) => {
    summary.count += 1;
    if (transaction.chargeKind === 'money') summary.chargedCents += transaction.chargedCents;
    if (transaction.chargeKind === 'pass' && Number.isInteger(transaction.estimatedCents)) {
      summary.estimatedPassCents += transaction.estimatedCents;
    }
    if (Number.isFinite(transaction.distanceKm)) summary.distanceKm += transaction.distanceKm;
    return summary;
  }, {
    count: 0,
    chargedCents: 0,
    estimatedPassCents: 0,
    distanceKm: 0,
  });
}
