import './styles.css';
import { extractStatement } from './statement.js';
import { estimateBusDistance, estimateRailDistance, loadTransitData } from './transit.js';
import { groupPassJourneys, summarize } from './fares.js';

const app = document.querySelector('#app');
const money = new Intl.NumberFormat('en-SG', { style: 'currency', currency: 'SGD' });
const date = new Intl.DateTimeFormat('en-SG', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'Asia/Singapore',
});
const time = new Intl.DateTimeFormat('en-SG', {
  hour: 'numeric',
  minute: '2-digit',
  timeZone: 'Asia/Singapore',
});
const month = new Intl.DateTimeFormat('en-SG', {
  month: 'long',
  year: 'numeric',
  timeZone: 'Asia/Singapore',
});

const state = {
  statement: null,
  transactions: [],
  transit: null,
  filters: null,
};
let transitDataPromise;

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function dateValue(isoDate) {
  return new Date(`${isoDate}T00:00:00+08:00`);
}

function safeUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.href : '#';
  } catch {
    return '#';
  }
}

app.innerHTML = `
  <header class="intro">
    <p class="eyebrow">Private transit statement review</p>
    <h1>FareCheck SG</h1>
    <p>Review every trip in a SimplyGo monthly statement and estimate what pass journeys would cost at standard adult card rates.</p>
  </header>

  <div id="status" class="status" role="status" aria-live="polite"></div>

  <div class="top-grid">
    <section id="upload-panel" class="panel upload-panel" aria-labelledby="upload-title">
      <div>
        <p class="section-kicker">Statement PDF</p>
        <h2 id="upload-title">Choose a statement</h2>
        <p>Text-based SimplyGo/LTA monthly statements up to 20 MiB.</p>
      </div>
      <input id="statement-file" type="file" accept="application/pdf,.pdf">
      <p class="privacy"><strong>Processed only in this browser.</strong> Your statement is not uploaded.</p>
    </section>
    <section id="metadata" class="panel metadata" aria-labelledby="metadata-title" hidden></section>
  </div>

  <section id="dashboard" hidden></section>

  <footer>
    <p>Estimates use <a href="https://simplygo.com.sg/travel-fares/adult-fares/">standard adult card fares effective 27 December 2025</a>. For the no-pass estimate, transfer grouping applies the <a href="https://www.ptc.gov.sg/fares/distance-fares-and-transfer-rules/">official PTC limits</a>: up to five transfers within two hours, 45-minute bus-involved and 15-minute train-to-train windows, with same-service and same-station exclusions. The statement provides boarding times, not alighting times. Rail distances are approximate. Results are informational.</p>
  </footer>
`;

const fileInput = document.querySelector('#statement-file');
const uploadPanel = document.querySelector('#upload-panel');
const metadata = document.querySelector('#metadata');
const dashboard = document.querySelector('#dashboard');
const status = document.querySelector('#status');

function announce(message, type = '') {
  status.textContent = message;
  status.className = `status${type ? ` status--${type}` : ''}`;
}

function renderMetadata() {
  const { statement, transactions, transit } = state;
  const busCount = transactions.filter((transaction) => transaction.mode === 'bus').length;
  const trainCount = transactions.length - busCount;
  const passCount = transactions.filter((transaction) => transaction.chargeKind === 'pass').length;
  const sourceLabels = {
    busRoutes: 'bus routes',
    busServices: 'bus services',
    busStops: 'bus stops',
    railStations: 'rail stations',
  };
  const sources = Object.entries(transit.sources)
    .map(([key, url]) => `<a href="${escapeHtml(safeUrl(url))}">${sourceLabels[key]}</a>`)
    .join(', ');

  metadata.hidden = false;
  metadata.innerHTML = `
    <p class="section-kicker">Loaded statement</p>
    <h2 id="metadata-title">${escapeHtml(month.format(dateValue(statement.periodStart)))}</h2>
    <p class="card-label">${escapeHtml(statement.cardLabel)} <span aria-label="card ending ${escapeHtml(statement.cardLast4)}">•••• ${escapeHtml(statement.cardLast4)}</span></p>
    <p>${escapeHtml(statement.holder)} · ${date.format(dateValue(statement.periodStart))}–${date.format(dateValue(statement.periodEnd))}</p>
    <p><strong>${transactions.length} trips</strong> · ${busCount} bus · ${trainCount} train · ${passCount} pass usage</p>
    <p class="attribution">Distance data updated ${escapeHtml(transit.updatedAt)} from ${sources}.</p>
  `;
}

function renderDashboard() {
  const { statement } = state;
  dashboard.hidden = false;
  dashboard.innerHTML = `
    ${statement.warnings.length ? `<div class="warning" role="alert">${statement.warnings.map(escapeHtml).join(' ')}</div>` : ''}
    <section id="summary" class="summary-grid" aria-label="Visible transaction summary" aria-live="polite"></section>

    <form id="filters" class="panel filters" aria-label="Filter transactions">
      <fieldset>
        <legend>Mode</legend>
        <div class="segmented">
          <label><input type="radio" name="mode" value="all" checked>All</label>
          <label><input type="radio" name="mode" value="bus">Bus</label>
          <label><input type="radio" name="mode" value="train">Train</label>
        </div>
      </fieldset>
      <label>From
        <input id="start-date" type="date" min="${statement.periodStart}" max="${statement.periodEnd}" value="${statement.periodStart}">
      </label>
      <label>To
        <input id="end-date" type="date" min="${statement.periodStart}" max="${statement.periodEnd}" value="${statement.periodEnd}">
      </label>
      <fieldset>
        <legend>Payment</legend>
        <div class="segmented">
          <label><input type="radio" name="payment" value="all" checked>All</label>
          <label><input type="radio" name="payment" value="pass">Pass usage</label>
          <label><input type="radio" name="payment" value="money">Money</label>
        </div>
      </fieldset>
    </form>

    <section class="transactions" aria-labelledby="transactions-title">
      <div class="list-heading">
        <div>
          <p class="section-kicker">Statement detail</p>
          <h2 id="transactions-title">Transactions</h2>
        </div>
        <p id="unresolved" class="unresolved"></p>
      </div>
      <div class="table-wrap">
        <table>
          <caption id="table-caption"></caption>
          <thead>
            <tr>
              <th scope="col">Date and time</th>
              <th scope="col">Mode</th>
              <th scope="col">Journey</th>
              <th scope="col">Payment</th>
              <th scope="col">Distance</th>
              <th scope="col">Estimated fare</th>
            </tr>
          </thead>
          <tbody id="transaction-rows"></tbody>
        </table>
      </div>
    </section>
  `;

  document.querySelectorAll('#filters input[name="mode"], #filters input[name="payment"]')
    .forEach((input) => input.addEventListener('change', () => {
      state.filters[input.name] = input.value;
      renderResults();
    }));
  document.querySelectorAll('#start-date, #end-date').forEach((input) => (
    input.addEventListener('change', updateDateFilters)
  ));
  renderResults();
}

function updateDateFilters() {
  const start = document.querySelector('#start-date');
  const end = document.querySelector('#end-date');
  const { periodStart, periodEnd } = state.statement;
  if (
    !start.value
    || !end.value
    || start.value > end.value
    || start.value < periodStart
    || end.value > periodEnd
  ) {
    start.value = periodStart;
    end.value = periodEnd;
    announce('The invalid date range was reset to the full statement period.', 'error');
  }
  state.filters.start = start.value;
  state.filters.end = end.value;
  renderResults();
}

function renderResults() {
  const filtered = state.transactions
    .filter((transaction) => (
      (state.filters.mode === 'all' || transaction.mode === state.filters.mode)
      && (state.filters.payment === 'all' || transaction.chargeKind === state.filters.payment)
      && transaction.occurredAt.slice(0, 10) >= state.filters.start
      && transaction.occurredAt.slice(0, 10) <= state.filters.end
    ))
    .sort((left, right) => Date.parse(right.occurredAt) - Date.parse(left.occurredAt));
  const totals = summarize(filtered);
  const journeySizes = state.transactions.reduce((sizes, transaction) => {
    if (transaction.journeyId) sizes.set(
      transaction.journeyId,
      (sizes.get(transaction.journeyId) ?? 0) + 1,
    );
    return sizes;
  }, new Map());
  const unresolvedCount = filtered.filter((transaction) => (
    transaction.chargeKind === 'pass' && transaction.estimatedCents === null
  )).length;

  document.querySelector('#summary').innerHTML = [
    ['Charged', money.format(totals.chargedCents / 100)],
    ['Estimated without pass', money.format(totals.estimatedPassCents / 100)],
    ['Trips', String(totals.count)],
    ['Distance', `${totals.distanceKm.toFixed(1)} km`],
  ].map(([label, value]) => `
    <article class="summary-card">
      <p>${label}</p>
      <strong>${value}</strong>
    </article>
  `).join('');

  document.querySelector('#unresolved').textContent = unresolvedCount
    ? `${unresolvedCount} ${unresolvedCount === 1 ? 'trip' : 'trips'} unavailable`
    : 'All visible pass estimates resolved';
  document.querySelector('#table-caption').textContent = `${filtered.length} visible ${filtered.length === 1 ? 'transaction' : 'transactions'}, newest first`;
  document.querySelector('#transaction-rows').innerHTML = filtered.length
    ? filtered.map((transaction) => {
      const combined = journeySizes.get(transaction.journeyId) > 1;
      const payment = transaction.chargeKind === 'pass'
        ? `Pass usage<span>${money.format(0)} charged</span>`
        : `Money<span>${money.format(transaction.chargedCents / 100)} charged</span>`;
      const estimate = transaction.chargeKind === 'money'
        ? '<span class="muted">Not applicable</span>'
        : transaction.estimatedCents === null
          ? `Unavailable<span>${escapeHtml(transaction.estimateReason)}</span>`
          : `${money.format(transaction.estimatedCents / 100)}<span>fare contribution</span>`;
      return `
        <tr>
          <td data-label="Date and time"><time datetime="${escapeHtml(transaction.occurredAt)}">${date.format(new Date(transaction.occurredAt))}<span>${time.format(new Date(transaction.occurredAt))}</span></time></td>
          <td data-label="Mode"><span class="mode mode--${transaction.mode}">${transaction.mode}</span><strong>${escapeHtml(transaction.service)}</strong></td>
          <td data-label="Journey"><strong>${escapeHtml(transaction.origin)}</strong><span class="route-arrow" aria-hidden="true">→</span><strong>${escapeHtml(transaction.destination)}</strong>${combined ? `<span class="journey-badge">Combined ${escapeHtml(transaction.journeyId)}</span>` : ''}</td>
          <td data-label="Payment">${payment}</td>
          <td data-label="Distance">${Number.isFinite(transaction.distanceKm) ? `${transaction.distanceKm.toFixed(2)} km` : `Unavailable<span>${escapeHtml(transaction.estimateReason)}</span>`}</td>
          <td data-label="Estimated fare">${estimate}</td>
        </tr>
      `;
    }).join('')
    : '<tr class="empty-row"><td colspan="6">No transactions match these filters.</td></tr>';
}

async function processFile(file) {
  if (!file) return;
  fileInput.disabled = true;
  uploadPanel.classList.add('is-processing');
  announce('Reading statement…');

  try {
    const [statement, transit] = await Promise.all([
      extractStatement(file),
      (transitDataPromise ??= loadTransitData()),
    ]);
    const withDistances = statement.transactions.map((transaction) => ({
      ...transaction,
      ...(transaction.mode === 'bus'
        ? estimateBusDistance(transaction, transit)
        : estimateRailDistance(transaction, transit)),
    }));
    const transactions = groupPassJourneys(withDistances);

    state.statement = statement;
    state.transactions = transactions;
    state.transit = transit;
    state.filters = {
      mode: 'all',
      payment: 'all',
      start: statement.periodStart,
      end: statement.periodEnd,
    };
    renderMetadata();
    renderDashboard();
    const warning = statement.warnings.length ? ` ${statement.warnings.join(' ')}` : '';
    announce(`Loaded ${transactions.length} trips.${warning}`, statement.warnings.length ? 'warning' : 'success');
    document.querySelector('#upload-title').textContent = 'Replace statement';
  } catch (error) {
    announce(error instanceof Error ? error.message : 'The statement could not be read.', 'error');
  } finally {
    fileInput.disabled = false;
    fileInput.value = '';
    uploadPanel.classList.remove('is-processing', 'is-dragging');
  }
}

fileInput.addEventListener('change', () => processFile(fileInput.files[0]));
for (const eventName of ['dragenter', 'dragover']) {
  uploadPanel.addEventListener(eventName, (event) => {
    event.preventDefault();
    uploadPanel.classList.add('is-dragging');
  });
}
for (const eventName of ['dragleave', 'drop']) {
  uploadPanel.addEventListener(eventName, (event) => {
    event.preventDefault();
    uploadPanel.classList.remove('is-dragging');
  });
}
uploadPanel.addEventListener('drop', (event) => processFile(event.dataTransfer.files[0]));
