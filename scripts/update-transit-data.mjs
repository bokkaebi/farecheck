import { mkdir, writeFile } from 'node:fs/promises';

const SOURCES = {
  busRoutes: 'https://raw.githubusercontent.com/cheeaun/sgbusdata/master/data/v1/raw/bus-routes.datamall.json',
  busServices: 'https://raw.githubusercontent.com/cheeaun/sgbusdata/master/data/v1/raw/bus-services.json',
  busStops: 'https://data.busrouter.sg/v1/stops.json',
  railStations: 'https://raw.githubusercontent.com/cheeaun/sgraildata/master/data/v1/sg-rail.geojson',
};

const RAIL_LINES = [
  ['NS1', 'NS2', 'NS3', 'NS4', 'NS5', 'NS7', 'NS8', 'NS9', 'NS10', 'NS11', 'NS12', 'NS13', 'NS14', 'NS15', 'NS16', 'NS17', 'NS18', 'NS19', 'NS20', 'NS21', 'NS22', 'NS23', 'NS24', 'NS25', 'NS26', 'NS27', 'NS28'],
  ['EW1', 'EW2', 'EW3', 'EW4', 'EW5', 'EW6', 'EW7', 'EW8', 'EW9', 'EW10', 'EW11', 'EW12', 'EW13', 'EW14', 'EW15', 'EW16', 'EW17', 'EW18', 'EW19', 'EW20', 'EW21', 'EW22', 'EW23', 'EW24', 'EW25', 'EW26', 'EW27', 'EW28', 'EW29', 'EW30', 'EW31', 'EW32', 'EW33'],
  ['EW4', 'CG1', 'CG2'],
  ['NE1', 'NE3', 'NE4', 'NE5', 'NE6', 'NE7', 'NE8', 'NE9', 'NE10', 'NE11', 'NE12', 'NE13', 'NE14', 'NE15', 'NE16', 'NE17', 'NE18'],
  ['CC1', 'CC2', 'CC3', 'CC4', 'CC5', 'CC6', 'CC7', 'CC8', 'CC9', 'CC10', 'CC11', 'CC12', 'CC13', 'CC14', 'CC15', 'CC16', 'CC17', 'CC19', 'CC20', 'CC21', 'CC22', 'CC23', 'CC24', 'CC25', 'CC26', 'CC27', 'CC28', 'CC29', 'CC30', 'CC31', 'CC32', 'CC33'],
  ['CC4', 'CC34', 'CC33'],
  ['DT1', 'DT2', 'DT3', 'DT4', 'DT5', 'DT6', 'DT7', 'DT8', 'DT9', 'DT10', 'DT11', 'DT12', 'DT13', 'DT14', 'DT15', 'DT16', 'DT17', 'DT18', 'DT19', 'DT20', 'DT21', 'DT22', 'DT23', 'DT24', 'DT25', 'DT26', 'DT27', 'DT28', 'DT29', 'DT30', 'DT31', 'DT32', 'DT33', 'DT34', 'DT35'],
  ['TE1', 'TE2', 'TE3', 'TE4', 'TE5', 'TE6', 'TE7', 'TE8', 'TE9', 'TE11', 'TE12', 'TE13', 'TE14', 'TE15', 'TE16', 'TE17', 'TE18', 'TE19', 'TE20', 'TE22', 'TE23', 'TE24', 'TE25', 'TE26', 'TE27', 'TE28', 'TE29'],
  ['BP1', 'BP2', 'BP3', 'BP4', 'BP5', 'BP6'],
  ['BP6', 'BP7', 'BP8', 'BP9', 'BP10', 'BP11', 'BP12', 'BP13', 'BP6'],
  ['STC', 'SE1', 'SE2', 'SE3', 'SE4', 'SE5', 'STC'],
  ['STC', 'SW1', 'SW2', 'SW3', 'SW4', 'SW5', 'SW6', 'SW7', 'SW8', 'STC'],
  ['PTC', 'PE1', 'PE2', 'PE3', 'PE4', 'PE5', 'PE6', 'PE7', 'PTC'],
  ['PTC', 'PW1', 'PW2', 'PW3', 'PW4', 'PW5', 'PW6', 'PW7', 'PTC'],
];

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json();
}

function distanceKm([longitudeA, latitudeA], [longitudeB, latitudeB]) {
  const radians = (degrees) => degrees * Math.PI / 180;
  const latitudeDelta = radians(latitudeB - latitudeA);
  const longitudeDelta = radians(longitudeB - longitudeA);
  const a = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(radians(latitudeA)) * Math.cos(radians(latitudeB))
    * Math.sin(longitudeDelta / 2) ** 2;
  // ponytail: estimated rail track distance; replace with an official distance matrix if one is published
  return Math.round(6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * 1.15 * 100) / 100;
}

function buildBusData(routeRows, services, stops) {
  const categories = new Map(services.map((service) => [String(service.number), service.type]));
  const grouped = new Map();

  for (const row of routeRows) {
    const service = String(row.ServiceNo);
    const direction = Number(row.Direction);
    const key = `${service}:${direction}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }

  const bus = {};
  for (const [key, rows] of [...grouped].sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true }))) {
    const [service, direction] = key.split(':');
    const route = rows
      .sort((a, b) => a.StopSequence - b.StopSequence)
      .filter((row) => Number.isFinite(Number(row.Distance)))
      .map((row) => [
        String(row.BusStopCode),
        stops[row.BusStopCode]?.[2] ?? '',
        Number(row.Distance),
      ]);
    if (!bus[service]) bus[service] = { category: categories.get(service) ?? 'UNKNOWN', directions: {} };
    bus[service].directions[direction] = route;
  }
  return bus;
}

function buildRailData(geojson) {
  const stationFeatures = geojson.features.filter((feature) => (
    feature.geometry?.type === 'Point'
    && feature.properties?.stop_type === 'station'
  ));
  const stations = {};
  const featureCodes = [];

  for (const feature of stationFeatures) {
    const codes = feature.properties.station_codes.match(/[A-Z]{1,3}\d{0,2}/g) ?? [];
    const coordinates = feature.geometry.coordinates;
    for (const code of codes) {
      stations[code] = [feature.properties.name, coordinates[0], coordinates[1]];
    }
    featureCodes.push(codes);
  }

  const usedCodes = new Set(RAIL_LINES.flat());
  for (const code of usedCodes) {
    if (!stations[code]) throw new Error(`Rail source is missing required station ${code}`);
  }

  const edges = [];
  const seen = new Set();
  const addEdge = (from, to, km) => {
    const key = [from, to].sort().join(':');
    if (seen.has(key)) return;
    seen.add(key);
    edges.push([from, to, km]);
  };

  for (const line of RAIL_LINES) {
    for (let index = 1; index < line.length; index += 1) {
      const from = line[index - 1];
      const to = line[index];
      addEdge(from, to, distanceKm(stations[from].slice(1), stations[to].slice(1)));
    }
  }

  for (const codes of featureCodes) {
    const operatingCodes = codes.filter((code) => usedCodes.has(code));
    for (let left = 0; left < operatingCodes.length; left += 1) {
      for (let right = left + 1; right < operatingCodes.length; right += 1) {
        addEdge(operatingCodes[left], operatingCodes[right], 0);
      }
    }
  }

  return {
    stations: Object.fromEntries(
      Object.entries(stations).filter(([code]) => usedCodes.has(code)).sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true })),
    ),
    edges: edges.sort(([aFrom, aTo], [bFrom, bTo]) => `${aFrom}:${aTo}`.localeCompare(`${bFrom}:${bTo}`, 'en', { numeric: true })),
  };
}

const [routeRows, services, stops, railGeojson] = await Promise.all(
  Object.values(SOURCES).map(fetchJson),
);
const snapshot = {
  updatedAt: new Date().toISOString().slice(0, 10),
  sources: SOURCES,
  bus: buildBusData(routeRows, services, stops),
  rail: buildRailData(railGeojson),
};

await mkdir('public/data', { recursive: true });
await writeFile('public/data/transit.json', `${JSON.stringify(snapshot)}\n`);
console.log(`Wrote public/data/transit.json (${Object.keys(snapshot.bus).length} bus services, ${Object.keys(snapshot.rail.stations).length} rail codes).`);
