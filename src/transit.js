const UNSUPPORTED_SERVICE = /EXPRESS|PREMIUM|CITYDIRECT/i;
const railCache = new WeakMap();

export function normalizeName(name) {
  return name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\bc['’]?wealth\b/g, 'commonwealth')
    .replace(/\bs['’]?goon\b/g, 'serangoon')
    .replace(/\bstn\b/g, 'station')
    .replace(/\bint\b/g, 'interchange')
    .replace(/\bcplx\b/g, 'complex')
    .replace(/\b(?:ccl|dtl|nsl|ewl|nel|tel|mrt|lrt)\b/g, ' ')
    .replace(/\b(?:exit|platform|boarding)\s*[a-z0-9/]*\b.*$/g, ' ')
    .replace(/\b(?:station|interchange)\b/g, ' ')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function samePlace(left, right) {
  const normalizedLeft = normalizeName(left);
  return normalizedLeft !== '' && normalizedLeft === normalizeName(right);
}

export async function loadTransitData() {
  const response = await fetch(`${import.meta.env.BASE_URL}data/transit.json`);
  if (!response.ok) throw new Error('Transit distance data could not be loaded.');
  return response.json();
}

function unavailable(reason) {
  return {
    distanceKm: null,
    estimateStatus: 'unavailable',
    estimateReason: reason,
  };
}

export function estimateBusDistance(transaction, data) {
  const service = data.bus[transaction.service];
  if (!service) return unavailable('Unknown bus service');
  if (UNSUPPORTED_SERVICE.test(service.category)) {
    return unavailable('Premium or express service');
  }

  const origin = normalizeName(transaction.origin);
  const destination = normalizeName(transaction.destination);
  const distances = [];
  let matchedOrigin = false;
  let matchedDestination = false;

  for (const route of Object.values(service.directions)) {
    const origins = [];
    const destinations = [];
    route.forEach((stop, index) => {
      const name = normalizeName(stop[1]);
      if (name === origin) origins.push(index);
      if (name === destination) destinations.push(index);
    });
    matchedOrigin ||= origins.length > 0;
    matchedDestination ||= destinations.length > 0;

    for (const originIndex of origins) {
      for (const destinationIndex of destinations) {
        if (destinationIndex <= originIndex) continue;
        const distance = route[destinationIndex][2] - route[originIndex][2];
        if (distance > 0) distances.push(distance);
      }
    }
  }

  if (!matchedOrigin || !matchedDestination) return unavailable('Stop not found on this service');
  if (distances.length === 0) return unavailable('No matching route direction');
  return {
    distanceKm: Math.round(Math.min(...distances) * 100) / 100,
    estimateStatus: 'estimated',
    estimateReason: null,
  };
}

function prepareRail(data) {
  if (railCache.has(data)) return railCache.get(data);

  const aliases = new Map();
  const graph = new Map();
  for (const [code, [name]] of Object.entries(data.rail.stations)) {
    const alias = normalizeName(name);
    if (!aliases.has(alias)) aliases.set(alias, new Set());
    aliases.get(alias).add(code);
    graph.set(code, []);
  }
  for (const [from, to, distance] of data.rail.edges) {
    graph.get(from)?.push([to, distance]);
    graph.get(to)?.push([from, distance]);
  }

  const prepared = { aliases, graph, distances: new Map() };
  railCache.set(data, prepared);
  return prepared;
}

function shortestRailDistance(originCodes, destinationCodes, graph) {
  const targets = new Set(destinationCodes);
  const distances = new Map([...originCodes].map((code) => [code, 0]));
  const visited = new Set();

  while (true) {
    let current = null;
    let currentDistance = Infinity;
    for (const [code, distance] of distances) {
      if (!visited.has(code) && distance < currentDistance) {
        current = code;
        currentDistance = distance;
      }
    }
    if (current === null) return null;
    if (targets.has(current)) return currentDistance;
    visited.add(current);

    for (const [next, edgeDistance] of graph.get(current) ?? []) {
      const nextDistance = currentDistance + edgeDistance;
      if (nextDistance < (distances.get(next) ?? Infinity)) distances.set(next, nextDistance);
    }
  }
}

export function estimateRailDistance(transaction, data) {
  const prepared = prepareRail(data);
  const origin = normalizeName(transaction.origin);
  const destination = normalizeName(transaction.destination);
  const originCodes = prepared.aliases.get(origin);
  const destinationCodes = prepared.aliases.get(destination);
  if (!originCodes || !destinationCodes) return unavailable('Station name not found');

  const cacheKey = [origin, destination].sort().join(':');
  let distance = prepared.distances.get(cacheKey);
  if (distance === undefined) {
    distance = shortestRailDistance(originCodes, destinationCodes, prepared.graph);
    prepared.distances.set(cacheKey, distance);
  }
  if (distance === null) return unavailable('Stations are disconnected');

  return {
    distanceKm: Math.round(distance * 100) / 100,
    estimateStatus: 'estimated',
    estimateReason: null,
  };
}
