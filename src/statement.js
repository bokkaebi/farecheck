/**
 * @typedef {'bus' | 'train'} TransitMode
 * @typedef {'pass' | 'money'} ChargeKind
 * @typedef {'pending' | 'estimated' | 'unavailable'} EstimateStatus
 *
 * @typedef {object} Transaction
 * @property {string} id
 * @property {string} occurredAt ISO Singapore-time timestamp with a +08:00 offset.
 * @property {TransitMode} mode
 * @property {string} service
 * @property {string} origin
 * @property {string} destination
 * @property {ChargeKind} chargeKind
 * @property {number} chargedCents
 * @property {string} rawCharge
 * @property {string | null} journeyId
 * @property {number | null} distanceKm
 * @property {number | null} estimatedCents
 * @property {EstimateStatus} estimateStatus
 * @property {string | null} estimateReason
 *
 * @typedef {object} Statement
 * @property {string} holder
 * @property {string} cardLabel
 * @property {string} cardLast4
 * @property {string} periodStart ISO calendar date.
 * @property {string} periodEnd ISO calendar date.
 * @property {Transaction[]} transactions
 * @property {string[]} warnings
 */

export const MAX_FILE_BYTES = 20 * 1024 * 1024;

const MONTHS = new Map(
  ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
    .map((month, index) => [month, index + 1]),
);
const DISPLAY_DATE = /(\d{2}) ([A-Z][a-z]{2}) (\d{4})/;
const PERIOD = /^(\d{2} [A-Z][a-z]{2} \d{4})\s+-\s+(\d{2} [A-Z][a-z]{2} \d{4})$/;
const CHARGE = /Pass Usage|\$\s*(\d+)\.(\d{2})/gi;
let pdfJsPromise;

function ensureNodePdfGlobals() {
  if (typeof DOMMatrix !== 'undefined') return;
  globalThis.DOMMatrix = class DOMMatrix {};
  globalThis.ImageData = class ImageData {};
  globalThis.Path2D = class Path2D {};
}

async function loadPdfJs() {
  ensureNodePdfGlobals();
  const pdfjs = await (pdfJsPromise ??= import('pdfjs-dist/build/pdf.mjs'));
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    '../node_modules/pdfjs-dist/build/pdf.worker.mjs',
    import.meta.url,
  ).href;
  return pdfjs;
}

function isoDate(displayDate) {
  const match = displayDate.match(DISPLAY_DATE);
  if (!match || !MONTHS.has(match[2])) throw new Error('The statement contains an invalid date.');
  return `${match[3]}-${String(MONTHS.get(match[2])).padStart(2, '0')}-${match[1]}`;
}

function singaporeTimestamp(displayDate, time, meridiem) {
  const [hours, minutes] = time.split(':').map(Number);
  const hour = (hours % 12) + (meridiem === 'PM' ? 12 : 0);
  return `${isoDate(displayDate)}T${String(hour).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:00+08:00`;
}

function lastCharge(text) {
  const matches = [...text.matchAll(CHARGE)];
  return matches.at(-1)?.[0].replace(/\s+/g, ' ') ?? null;
}

export function parseChargeCents(rawCharge) {
  if (/^Pass Usage$/i.test(rawCharge)) return 0;
  const match = rawCharge.match(/\$\s*(\d+)\.(\d{2})/);
  return Number(match[1]) * 100 + Number(match[2]);
}

function pageLines(textItems) {
  const groups = [];

  for (const item of textItems) {
    if (!('str' in item) || !item.str.trim()) continue;
    const y = item.transform[5];
    let group = groups.find((candidate) => Math.abs(candidate.y - y) <= 2);
    if (!group) {
      group = { y, items: [] };
      groups.push(group);
    }
    group.items.push({
      text: item.str.trim(),
      x: item.transform[4],
      width: item.width,
      height: item.height,
    });
  }

  return groups
    .sort((a, b) => b.y - a.y)
    .map((group) => {
      group.items.sort((a, b) => a.x - b.x);
      let text = '';
      let right = -Infinity;
      for (const item of group.items) {
        if (text && item.x - right > Math.max(1, item.height * 0.15)) text += ' ';
        text += item.text;
        right = item.x + item.width;
      }
      return { text, x: group.items[0].x, y: group.y };
    });
}

function parsePageTransactions(lines, pageNumber) {
  const transactions = [];
  let candidates = 0;
  let failed = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const dateMatch = line.text.match(new RegExp(`^${DISPLAY_DATE.source}`));
    if (!dateMatch || line.x > 100 || PERIOD.test(line.text)) continue;
    candidates += 1;

    const nearbyCharge = index > 0 && line.y - lines[index - 1].y >= -6
      ? lastCharge(lines[index - 1].text)
      : null;
    const rawCharge = lastCharge(line.text) ?? nearbyCharge;
    const detail = lines.slice(index + 1, index + 5)
      .find((candidate) => /^\d{2}:\d{2} (?:AM|PM) (?:Bus \S+|Train)\s+/.test(candidate.text));
    const detailMatch = detail?.text.match(
      /^(\d{2}:\d{2}) (AM|PM) (?:Bus (\S+)|(Train))\s+(.+)$/,
    );
    const separator = detailMatch?.[5].indexOf(' - ') ?? -1;

    if (!rawCharge || !detailMatch || separator < 1) {
      failed += 1;
      continue;
    }

    const journey = detailMatch[5];
    const occurredAt = singaporeTimestamp(dateMatch[0], detailMatch[1], detailMatch[2]);
    const mode = detailMatch[4] ? 'train' : 'bus';
    transactions.push({
      id: `${occurredAt}-${pageNumber}-${candidates}`,
      occurredAt,
      mode,
      service: mode === 'bus' ? detailMatch[3] : 'Train',
      origin: journey.slice(0, separator).trim(),
      destination: journey.slice(separator + 3).trim(),
      chargeKind: /^Pass Usage$/i.test(rawCharge) ? 'pass' : 'money',
      chargedCents: parseChargeCents(rawCharge),
      rawCharge,
      journeyId: null,
      distanceKm: null,
      estimatedCents: null,
      estimateStatus: 'pending',
      estimateReason: null,
    });
  }

  return { transactions, candidates, failed };
}

function parseMetadata(lines) {
  const periodLine = lines.find((line) => PERIOD.test(line.text))?.text;
  const period = periodLine?.match(PERIOD);
  const title = lines.find((line) => / Transit Statement$/.test(line.text));
  const cardIndex = lines.findIndex((line) => /^(?:\d{4}\s+){3}\d{4}$/.test(line.text));
  const cardNumber = cardIndex >= 0 ? lines[cardIndex].text : '';
  const label = cardIndex > 0 ? lines[cardIndex - 1].text : '';
  const holder = cardIndex > 1 ? lines[cardIndex - 2].text : '';

  if (!period || !title || !cardNumber || !label || !holder) {
    throw new Error('This PDF is not a supported SimplyGo transit statement.');
  }

  return {
    holder,
    cardLabel: label,
    cardLast4: cardNumber.replace(/\D/g, '').slice(-4),
    periodStart: isoDate(period[1]),
    periodEnd: isoDate(period[2]),
  };
}

function sourceBytes(source) {
  if (source instanceof Uint8Array) return Promise.resolve(source);
  if (
    source
    && typeof source.size === 'number'
    && typeof source.arrayBuffer === 'function'
  ) {
    if (source.size > MAX_FILE_BYTES) {
      throw new Error('Choose a PDF smaller than 20 MiB.');
    }
    return source.arrayBuffer().then((buffer) => new Uint8Array(buffer));
  }
  throw new Error('Choose a PDF file.');
}

/**
 * Extract a supported SimplyGo monthly statement without uploading it.
 * @param {File | Uint8Array} source
 * @returns {Promise<Statement>}
 */
export async function extractStatement(source) {
  const bytes = await sourceBytes(source);
  if (bytes.byteLength > MAX_FILE_BYTES) throw new Error('Choose a PDF smaller than 20 MiB.');
  if (new TextDecoder().decode(bytes.subarray(0, 5)) !== '%PDF-') {
    throw new Error('Choose a valid PDF file.');
  }

  const pdfjs = await loadPdfJs();
  let document;
  try {
    document = await pdfjs.getDocument({ data: bytes, isEvalSupported: false }).promise;
  } catch (error) {
    if (error?.name === 'PasswordException') {
      throw new Error('Encrypted PDFs are not supported.');
    }
    throw new Error('This PDF could not be read.');
  }

  try {
    const pages = [];
    let textItemCount = 0;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      textItemCount += content.items.filter((item) => 'str' in item && item.str.trim()).length;
      pages.push(pageLines(content.items));
    }

    if (textItemCount === 0) throw new Error('This PDF has no readable text layer.');

    const metadata = parseMetadata(pages[0]);
    const parsed = pages.map((lines, index) => parsePageTransactions(lines, index + 1));
    const transactions = parsed.flatMap((page) => page.transactions);
    const failed = parsed.reduce((total, page) => total + page.failed, 0);

    if (transactions.length === 0) {
      throw new Error('No recognisable transit rows were found in this PDF.');
    }

    return {
      ...metadata,
      transactions,
      warnings: failed
        ? [`${failed} transit ${failed === 1 ? 'row was' : 'rows were'} not parsed.`]
        : [],
    };
  } finally {
    await document.destroy();
  }
}
