import { createServer } from 'node:http';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { extname, isAbsolute, join, normalize, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, timingSafeEqual, webcrypto } from 'node:crypto';
import {
  DEFAULT_ADDRESS_BOOK_UPLOAD_LIMIT_BYTES,
  parseAddressBookBuffer,
  validateAddressBookUpload,
} from './address-book.js';

const API_BASE = 'https://api-gateway.xangle.io';
const EXPLORER_ORIGIN = 'https://msu-explorer.xangle.io';
const CHAIN = 'NEXON';
const PORT = Number(process.env.PORT || 3000);
const MAX_PAGES = Number(process.env.MAX_PAGES || 20);
const PAGE_SIZE = Number(process.env.PAGE_SIZE || 25);
const RECENT_LIMIT = 3;
const HISTORY_LIMIT = Number(process.env.HISTORY_LIMIT || 200);
const HISTORY_WINDOW_DAYS = Number(process.env.HISTORY_WINDOW_DAYS || 7);
const HISTORY_CACHE_MS = Number(process.env.HISTORY_CACHE_MS || 60 * 1000);
const HISTORY_ADDRESS_CONCURRENCY = Number(process.env.HISTORY_ADDRESS_CONCURRENCY || 8);
const BODY_LIMIT = 1024 * 1024;
const ADDRESS_BOOK_UPLOAD_LIMIT = Number(
  process.env.ADDRESS_BOOK_UPLOAD_LIMIT_BYTES || DEFAULT_ADDRESS_BOOK_UPLOAD_LIMIT_BYTES,
);
const ADDRESS_BOOK_REPO_PATH = 'data/address-book.xlsx';
const ADDRESS_BOOK_COMMIT_MESSAGE = 'chore: update address book from website';

const rootDir = fileURLToPath(new URL('.', import.meta.url));
const publicDir = join(rootDir, 'public');
const addressBookPath = join(rootDir, 'data', 'address-book.xlsx');
const adminPasswordPath = join(rootDir, 'data', 'admin-password.txt');

let appVersionCache = {
  value: '',
  expiresAt: 0,
};

let secretCache = {
  key: '',
  expiresAt: 0,
};

let historyCache = {
  value: null,
  expiresAt: 0,
};

const filteredHistoryCache = new Map();
const transactionDetailCache = new Map();
let addressBookRuntimeBuffer = null;

const json = (res, status, payload) => {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(payload));
};

const text = (res, status, payload, contentType = 'text/plain; charset=utf-8') => {
  res.writeHead(status, {
    'content-type': contentType,
    'cache-control': 'no-store',
  });
  res.end(payload);
};

const readRequestBuffer = async (req, limit = BODY_LIMIT) => {
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      const error = new Error('请求内容太大。');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }

  return chunks.length ? Buffer.concat(chunks) : Buffer.alloc(0);
};

const readJsonBody = async (req) => {
  const buffer = await readRequestBuffer(req, BODY_LIMIT);
  if (!buffer.length) return {};
  return JSON.parse(buffer.toString('utf8'));
};

const getAppVersion = async () => {
  if (appVersionCache.value && Date.now() < appVersionCache.expiresAt) {
    return appVersionCache.value;
  }

  const files = [
    join(rootDir, 'server.js'),
    join(rootDir, 'address-book.js'),
    join(rootDir, 'package.json'),
    join(publicDir, 'index.html'),
    addressBookPath,
  ];
  const hash = createHash('sha256');

  for (const file of files) {
    try {
      hash.update(file === addressBookPath && addressBookRuntimeBuffer
        ? addressBookRuntimeBuffer
        : await readFile(file));
    } catch {
      hash.update(file);
    }
  }

  appVersionCache = {
    value: hash.digest('hex').slice(0, 16),
    expiresAt: Date.now() + 10 * 1000,
  };

  return appVersionCache.value;
};

const createApiError = (message, statusCode = 500) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
};

const getHeaderValue = (req, name) => {
  const value = req.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value || '';
};

const readAddressBookBuffer = async () => (
  addressBookRuntimeBuffer || readFile(addressBookPath)
);

const resetAddressBookCaches = () => {
  appVersionCache = { value: '', expiresAt: 0 };
  historyCache = { value: null, expiresAt: 0 };
  filteredHistoryCache.clear();
};

const getConfiguredAdminPassword = async () => {
  const envPassword = String(process.env.ADDRESS_BOOK_ADMIN_PASSWORD || '').trim();
  if (envPassword) return envPassword;

  try {
    const filePassword = String(await readFile(adminPasswordPath, 'utf8')).trim();
    return filePassword || null;
  } catch {
    return null;
  }
};

const passwordDigest = (value) => createHash('sha256').update(String(value)).digest();

const verifyAdminPassword = async (req) => {
  const expectedPassword = await getConfiguredAdminPassword();
  if (!expectedPassword) {
    throw createApiError('管理员密码未配置，请先设置 ADDRESS_BOOK_ADMIN_PASSWORD 或 data/admin-password.txt。', 503);
  }

  const providedPassword = String(getHeaderValue(req, 'x-admin-password')).trim();
  if (!providedPassword || !timingSafeEqual(passwordDigest(providedPassword), passwordDigest(expectedPassword))) {
    throw createApiError('管理员密码不正确。', 401);
  }
};

const getGitHubUploadConfig = () => {
  const token = String(process.env.ADDRESS_BOOK_GITHUB_TOKEN || process.env.GITHUB_TOKEN || '').trim();
  if (!token) return null;

  return {
    token,
    repo: String(process.env.ADDRESS_BOOK_GITHUB_REPO || process.env.GITHUB_REPOSITORY || 'yoyobs/MSU-Check').trim(),
    branch: String(process.env.ADDRESS_BOOK_GITHUB_BRANCH || process.env.VERCEL_GIT_COMMIT_REF || 'main').trim(),
  };
};

const gitHubHeaders = (token) => ({
  accept: 'application/vnd.github+json',
  authorization: `Bearer ${token}`,
  'content-type': 'application/json',
  'x-github-api-version': '2022-11-28',
});

const gitHubContentUrl = ({ repo, branch }, includeRef = false) => {
  const path = ADDRESS_BOOK_REPO_PATH.split('/').map(encodeURIComponent).join('/');
  const url = `https://api.github.com/repos/${repo}/contents/${path}`;
  return includeRef ? `${url}?ref=${encodeURIComponent(branch)}` : url;
};

const getGitHubFileSha = async (config) => {
  const response = await fetch(gitHubContentUrl(config, true), {
    headers: gitHubHeaders(config.token),
  });

  if (response.status === 404) return null;

  if (!response.ok) {
    throw createApiError('读取 GitHub 名单文件失败。', 502);
  }

  const data = await response.json();
  return data.sha || null;
};

const commitAddressBookToGitHub = async (buffer, config) => {
  const sha = await getGitHubFileSha(config);
  const response = await fetch(gitHubContentUrl(config), {
    method: 'PUT',
    headers: gitHubHeaders(config.token),
    body: JSON.stringify({
      message: ADDRESS_BOOK_COMMIT_MESSAGE,
      content: buffer.toString('base64'),
      branch: config.branch,
      ...(sha ? { sha } : {}),
    }),
  });

  if (!response.ok) {
    throw createApiError('提交 GitHub 名单文件失败。', 502);
  }

  const data = await response.json();
  return {
    mode: 'github',
    branch: config.branch,
    commit: data.commit?.sha || '',
    url: data.commit?.html_url || '',
  };
};

const replaceLocalAddressBook = async (buffer) => {
  const tempPath = `${addressBookPath}.${Date.now()}.tmp`;
  await writeFile(tempPath, buffer);
  await rename(tempPath, addressBookPath);
  return { mode: 'local' };
};

const persistAddressBookUpload = async (buffer) => {
  const gitHubConfig = getGitHubUploadConfig();

  if (gitHubConfig) {
    const result = await commitAddressBookToGitHub(buffer, gitHubConfig);
    addressBookRuntimeBuffer = Buffer.from(buffer);
    resetAddressBookCaches();
    return result;
  }

  if (process.env.VERCEL) {
    throw createApiError('线上上传需要先在 Vercel 配置 ADDRESS_BOOK_GITHUB_TOKEN。', 503);
  }

  const result = await replaceLocalAddressBook(buffer);
  addressBookRuntimeBuffer = null;
  resetAddressBookCaches();
  return result;
};

const randomHash = () => {
  const bytes = new Uint8Array(32);
  webcrypto.getRandomValues(bytes);
  return `0x${Array.from(bytes).map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
};

const generateSecretKey = ({ s, d }) => {
  let targetIndex = null;
  const now = Date.now();

  try {
    const targetValue = parseInt(Buffer.from(s, 'base64').toString('binary'), 10);

    if (!Number.isNaN(targetValue)) {
      for (let index = 0; index < 36; index += 1) {
        if (now > 0 && ((index * 5 + 11) ^ 47) + index * 3 === targetValue) {
          targetIndex = index;
          break;
        }
      }
    }
  } catch {
    targetIndex = null;
  }

  if (targetIndex === null || targetIndex < 0 || targetIndex >= d.length) {
    return null;
  }

  const source = d[35 - targetIndex].slice(2);
  const first = randomHash().slice(2);
  const second = randomHash().slice(2);
  const chars = (first + second).split('');
  const expectedLength = chars.length;

  for (let cursor = 0; cursor < 64; cursor += 2) {
    const sourceIndex = cursor / 2;
    if (sourceIndex < source.length) chars[cursor] = source[sourceIndex];
  }

  for (let cursor = 65; cursor < 128; cursor += 2) {
    const sourceIndex = 32 + (cursor - 65) / 2;
    if (sourceIndex < source.length) chars[cursor] = source[sourceIndex];
  }

  const key = chars.join('');
  return key.length === expectedLength ? key : null;
};

const explorerHeaders = (secretKey) => ({
  accept: 'application/json',
  'content-type': 'application/json',
  'x-chain': CHAIN,
  origin: EXPLORER_ORIGIN,
  referer: `${EXPLORER_ORIGIN}/`,
  'user-agent': 'Mozilla/5.0',
  ...(secretKey ? { 'x-secret-key': secretKey } : {}),
});

const getSecretKey = async (force = false) => {
  if (!force && secretCache.key && Date.now() < secretCache.expiresAt) {
    return secretCache.key;
  }

  const response = await fetch(`${API_BASE}/api/secret/key`, {
    method: 'POST',
    headers: explorerHeaders(),
    body: JSON.stringify({ hash: randomHash() }),
  });

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`Secret key request failed: ${response.status} ${raw}`);
  }

  const data = JSON.parse(raw);
  const key = generateSecretKey({ s: data.SECRET, d: data.DATALIST });
  if (!key) throw new Error('Secret key generation failed.');

  secretCache = {
    key,
    expiresAt: Date.now() + 4 * 60 * 1000,
  };

  return key;
};

const explorerPost = async (path, body, retry = true) => {
  const key = await getSecretKey();
  const response = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: explorerHeaders(key),
    body: JSON.stringify(body),
  });

  const raw = await response.text();

  if (response.status === 401 && retry) {
    secretCache = { key: '', expiresAt: 0 };
    return explorerPost(path, body, false);
  }

  if (!response.ok) {
    throw new Error(`Explorer API failed: ${response.status} ${raw}`);
  }

  return JSON.parse(raw);
};

const normalizeAddress = (value) => String(value || '').trim().toLowerCase();

const mapTransaction = (trx) => ({
  hash: trx.TRXHA,
  method: trx.MTH,
  blockNumber: trx.BNO,
  age: trx.AG,
  from: trx.ADDRSFROMINFO?.ADDR || '',
  fromName: trx.ADDRSFROMINFO?.NN || '',
  to: trx.ADDRSTOINFO?.ADDR || '',
  toName: trx.ADDRSTOINFO?.NN || '',
  amount: trx.VAL,
  fee: trx.TRXF,
  timestamp: trx.UT,
  explorerUrl: `${EXPLORER_ORIGIN}/transactions/${trx.TRXHA}`,
});

const mapTokenTransfer = ({ trx, transfer }) => ({
  hash: trx.TRXA || trx.TRXHA,
  method: trx.MTH || 'transfer',
  blockNumber: trx.BNO,
  age: trx.AG,
  from: transfer.ADDRSFROMINFO?.ADDR || '',
  fromName: transfer.ADDRSFROMINFO?.NN || '',
  to: transfer.ADDRSTOINFO?.ADDR || '',
  toName: transfer.ADDRSTOINFO?.NN || '',
  amount: transfer.QTY || trx.VAL,
  tokenSymbol: transfer.TKNSINFO?.SB || 'NESO',
  tokenName: transfer.TKNSINFO?.NN || '',
  fee: trx.TRXF,
  timestamp: trx.UT,
  explorerUrl: `${EXPLORER_ORIGIN}/transactions/${trx.TRXA || trx.TRXHA}/transaction`,
});

const buildAddressLookup = (addresses) => {
  const lookup = new Map();

  for (const item of addresses) {
    lookup.set(normalizeAddress(item.address), item);
  }

  return lookup;
};

const withBookNames = (transaction, lookup) => {
  const fromBook = lookup.get(normalizeAddress(transaction.from));
  const toBook = lookup.get(normalizeAddress(transaction.to));

  return {
    ...transaction,
    fromNickname: fromBook?.nickname || transaction.fromName || '',
    toNickname: toBook?.nickname || transaction.toName || '',
  };
};

const timestampToMs = (timestamp) => {
  const value = Number(timestamp);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value < 10_000_000_000 ? value * 1000 : value;
};

const parseDateBoundary = (value, boundary) => {
  const text = String(value || '').trim();
  if (!text) return NaN;

  const dateOnly = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnly) {
    const year = Number(dateOnly[1]);
    const month = Number(dateOnly[2]);
    const day = Number(dateOnly[3]);
    const timezoneOffsetMs = 8 * 60 * 60 * 1000;

    return boundary === 'end'
      ? Date.UTC(year, month - 1, day + 1) - timezoneOffsetMs - 1
      : Date.UTC(year, month - 1, day) - timezoneOffsetMs;
  }

  return Date.parse(text);
};

const parseDateRange = ({ startDate, endDate }) => {
  const startMs = parseDateBoundary(startDate, 'start');
  const endMs = parseDateBoundary(endDate, 'end');

  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    const error = new Error('Invalid date range. Use YYYY-MM-DD or ISO date strings.');
    error.statusCode = 400;
    throw error;
  }

  if (endMs < startMs) {
    const error = new Error('endDate must be greater than or equal to startDate.');
    error.statusCode = 400;
    throw error;
  }

  return { startMs, endMs };
};

const amountScale = 10n ** 18n;

const parseNesoAmountUnits = (value) => {
  const text = String(value ?? '').trim().replace(/,/g, '');
  if (!/^\d+(?:\.\d+)?$/.test(text)) return null;

  const [whole, fraction = ''] = text.split('.');
  const extraFraction = fraction.slice(18);
  if (/[1-9]/.test(extraFraction)) return null;

  return BigInt(whole) * amountScale + BigInt((fraction.slice(0, 18) + '0'.repeat(18)).slice(0, 18));
};

const requireAddress = (value, fieldName) => {
  const address = normalizeAddress(value);
  if (!/^0x[a-f0-9]{40}$/.test(address)) {
    const error = new Error(`${fieldName} must be a valid 0x address.`);
    error.statusCode = 400;
    throw error;
  }

  return address;
};

const getQueryValue = (searchParams, names) => {
  for (const name of names) {
    const value = searchParams.get(name);
    if (value !== null) return value;
  }

  return null;
};

const getTransactionDetail = async (hash) => {
  const normalizedHash = normalizeAddress(hash);
  if (!normalizedHash) return null;

  if (!transactionDetailCache.has(normalizedHash)) {
    transactionDetailCache.set(normalizedHash, explorerPost('/api/transaction', {
      trxHash: hash,
    }));
  }

  return transactionDetailCache.get(normalizedHash);
};

const isNesoTransfer = (transfer) => String(transfer.TKNSINFO?.SB || '').trim().toUpperCase() === 'NESO';

const listTokenTransfers = async ({ trx, lookup, matchTransfer }) => {
  const detail = await getTransactionDetail(trx.TRXHA);
  const transfers = Array.isArray(detail?.E20TLI) ? detail.E20TLI : [];

  return transfers
    .filter((transfer) => {
      const from = normalizeAddress(transfer.ADDRSFROMINFO?.ADDR);
      const to = normalizeAddress(transfer.ADDRSTOINFO?.ADDR);
      return isNesoTransfer(transfer) && from && to && from !== to && matchTransfer({ from, to, transfer });
    })
    .map((transfer) => withBookNames(mapTokenTransfer({ trx: detail, transfer }), lookup));
};

const scanAddressHistory = async ({ address, sinceMs, addressSet, lookup, matchTransfer }) => {
  const candidates = new Map();
  const checked = {
    pages: 0,
    transactions: 0,
    details: 0,
  };

  for (let page = 1; ; page += 1) {
    const data = await explorerPost('/api/address/transaction/list', {
      address,
      page,
      size: PAGE_SIZE,
    });

    const list = Array.isArray(data.TRXLIST) ? data.TRXLIST : [];
    checked.pages += 1;
    checked.transactions += list.length;

    let hasRecentTransaction = false;

    for (const trx of list) {
      const timestampMs = timestampToMs(trx.UT);
      if (timestampMs >= sinceMs) hasRecentTransaction = true;
      if (!timestampMs || timestampMs < sinceMs) continue;

      candidates.set(normalizeAddress(trx.TRXHA), trx);
    }

    if (list.length < PAGE_SIZE || !hasRecentTransaction) break;
  }

  const transactions = [];
  const details = await Promise.all(Array.from(candidates.values()).map((trx) => listTokenTransfers({
    trx,
    lookup,
    matchTransfer: matchTransfer || (({ from, to }) => addressSet.has(from) && addressSet.has(to)),
  })));

  checked.details = candidates.size;

  for (const items of details) {
    transactions.push(...items);
  }

  return {
    transactions,
    checked,
  };
};

const listRecentPayments = async ({ sender, receiver }) => {
  const senderAddress = normalizeAddress(sender);
  const receiverAddress = normalizeAddress(receiver);

  if (!senderAddress || !receiverAddress) {
    const error = new Error('请先选择交易者A和交易者B。');
    error.statusCode = 400;
    throw error;
  }

  const checked = {
    pages: 0,
    transactions: 0,
    details: 0,
    days: HISTORY_WINDOW_DAYS,
  };
  const sinceMs = Date.now() - HISTORY_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const addressSet = new Set([senderAddress, receiverAddress]);
  const { addresses } = await readAddressBook();
  const lookup = buildAddressLookup(addresses);
  const scanState = Array.from(addressSet).map((address) => ({
    address,
    page: 1,
    done: false,
    lastOldestMs: Number.POSITIVE_INFINITY,
  }));
  const byHash = new Map();

  while (scanState.some((item) => !item.done)) {
    const activeScans = scanState.filter((item) => !item.done);
    const pageResults = await Promise.all(activeScans.map(async (scan) => {
      const data = await explorerPost('/api/address/transaction/list', {
        address: scan.address,
        page: scan.page,
        size: PAGE_SIZE,
      });

      return {
        scan,
        list: Array.isArray(data.TRXLIST) ? data.TRXLIST : [],
      };
    }));

    const candidates = new Map();

    for (const { scan, list } of pageResults) {
      checked.pages += 1;
      checked.transactions += list.length;

      let hasRecentTransaction = false;
      let oldestMs = Number.POSITIVE_INFINITY;

      for (const trx of list) {
        const timestampMs = timestampToMs(trx.UT);
        if (!timestampMs) continue;

        oldestMs = Math.min(oldestMs, timestampMs);
        if (timestampMs >= sinceMs) {
          hasRecentTransaction = true;
          candidates.set(normalizeAddress(trx.TRXHA), trx);
        }
      }

      scan.lastOldestMs = oldestMs;
      scan.page += 1;

      if (list.length < PAGE_SIZE || !hasRecentTransaction) {
        scan.done = true;
      }
    }

    const transferGroups = await Promise.all(Array.from(candidates.values()).map((trx) => listTokenTransfers({
      trx,
      lookup,
      matchTransfer: ({ from, to }) => addressSet.has(from) && addressSet.has(to),
    })));
    checked.details += candidates.size;

    for (const transfers of transferGroups) {
      for (const transaction of transfers) {
        byHash.set(transaction.hash, transaction);
      }
    }

    const currentMatches = Array.from(byHash.values())
      .sort((a, b) => timestampToMs(b.timestamp) - timestampToMs(a.timestamp));

    if (currentMatches.length >= RECENT_LIMIT) {
      const cutoffMs = timestampToMs(currentMatches[RECENT_LIMIT - 1].timestamp);
      const newerPagesExhausted = scanState.every((scan) => scan.done || scan.lastOldestMs <= cutoffMs);

      if (newerPagesExhausted) {
        break;
      }
    }
  }

  const matches = Array.from(byHash.values())
    .sort((a, b) => timestampToMs(b.timestamp) - timestampToMs(a.timestamp))
    .slice(0, RECENT_LIMIT);

  return {
    found: matches.length > 0,
    message: matches.length ? '已找到最近交易' : '还没收到钱',
    transactions: matches,
    checked,
  };
};

const findTransferByQuery = async ({ startDate, endDate, sender, receiver, amount }) => {
  const senderAddress = requireAddress(sender, 'sender');
  const receiverAddress = requireAddress(receiver, 'receiver');
  const { startMs, endMs } = parseDateRange({ startDate, endDate });
  const expectedAmount = parseNesoAmountUnits(amount);

  if (expectedAmount === null) {
    const error = new Error('amount must be a valid NESO amount with up to 18 decimal places.');
    error.statusCode = 400;
    throw error;
  }

  const { addresses } = await readAddressBook();
  const lookup = buildAddressLookup(addresses);
  const scannedHashes = new Set();
  const scanAddresses = Array.from(new Set([senderAddress, receiverAddress]));

  for (const address of scanAddresses) {
    for (let page = 1; ; page += 1) {
      const data = await explorerPost('/api/address/transaction/list', {
        address,
        page,
        size: PAGE_SIZE,
      });

      const list = Array.isArray(data.TRXLIST) ? data.TRXLIST : [];
      let hasTransactionWithinOrAfterStart = false;

      for (const trx of list) {
        const timestampMs = timestampToMs(trx.UT);
        if (!timestampMs) continue;
        if (timestampMs >= startMs) hasTransactionWithinOrAfterStart = true;
        if (timestampMs < startMs || timestampMs > endMs) continue;

        const hash = normalizeAddress(trx.TRXHA);
        if (!hash || scannedHashes.has(hash)) continue;
        scannedHashes.add(hash);

        const transfers = await listTokenTransfers({
          trx,
          lookup,
          matchTransfer: ({ from, to, transfer }) => (
            from === senderAddress
            && to === receiverAddress
            && parseNesoAmountUnits(transfer.QTY) === expectedAmount
          ),
        });

        if (transfers.length) return true;
      }

      if (list.length < PAGE_SIZE || !hasTransactionWithinOrAfterStart) break;
    }
  }

  return false;
};

const listAddressBookHistory = async ({ selectedAddress } = {}) => {
  const normalizedSelectedAddress = normalizeAddress(selectedAddress);
  const cacheKey = normalizedSelectedAddress || 'all';
  const cached = normalizedSelectedAddress ? filteredHistoryCache.get(cacheKey) : historyCache;

  if (cached?.value && Date.now() < cached.expiresAt) {
    return cached.value;
  }

  if (!normalizedSelectedAddress && historyCache.value && Date.now() < historyCache.expiresAt) {
    return historyCache.value;
  }

  const { addresses } = await readAddressBook();
  const lookup = buildAddressLookup(addresses);
  const addressSet = new Set(lookup.keys());
  const selectedBookEntry = normalizedSelectedAddress ? lookup.get(normalizedSelectedAddress) : null;
  const uniqueAddresses = normalizedSelectedAddress ? [normalizedSelectedAddress] : Array.from(addressSet);
  const sinceMs = Date.now() - HISTORY_WINDOW_DAYS * 24 * 60 * 60 * 1000;

  if (normalizedSelectedAddress && !selectedBookEntry) {
    return {
      transactions: [],
      checked: {
        selectedAddress: normalizedSelectedAddress,
        selectedNickname: '',
        addresses: addressSet.size,
        pages: 0,
        transactions: 0,
        days: HISTORY_WINDOW_DAYS,
      },
      message: '选中的地址不在名单里。',
    };
  }

  if (addressSet.size < 2) {
    return {
      transactions: [],
      checked: {
        selectedAddress: normalizedSelectedAddress,
        selectedNickname: selectedBookEntry?.nickname || '',
        addresses: addressSet.size,
        pages: 0,
        transactions: 0,
        days: HISTORY_WINDOW_DAYS,
      },
    };
  }

  const checked = {
    selectedAddress: normalizedSelectedAddress,
    selectedNickname: selectedBookEntry?.nickname || '',
    addresses: addressSet.size,
    pages: 0,
    transactions: 0,
    details: 0,
    days: HISTORY_WINDOW_DAYS,
  };
  const byHash = new Map();

  for (let index = 0; index < uniqueAddresses.length; index += HISTORY_ADDRESS_CONCURRENCY) {
    const batch = uniqueAddresses.slice(index, index + HISTORY_ADDRESS_CONCURRENCY);
    const results = await Promise.all(batch.map((address) => scanAddressHistory({
      address,
      sinceMs,
      addressSet,
      lookup,
      matchTransfer: normalizedSelectedAddress
        ? ({ from, to }) => addressSet.has(from) && addressSet.has(to) && (from === normalizedSelectedAddress || to === normalizedSelectedAddress)
        : undefined,
    })));

    for (const result of results) {
      checked.pages += result.checked.pages;
      checked.transactions += result.checked.transactions;
      checked.details += result.checked.details;

      for (const transaction of result.transactions) {
        byHash.set(transaction.hash, transaction);
      }
    }
  }

  const transactions = Array.from(byHash.values())
    .sort((a, b) => timestampToMs(b.timestamp) - timestampToMs(a.timestamp))
    .slice(0, HISTORY_LIMIT);

  const result = {
    transactions,
    checked,
  };

  const nextCache = {
    value: result,
    expiresAt: Date.now() + HISTORY_CACHE_MS,
  };

  if (normalizedSelectedAddress) {
    filteredHistoryCache.set(cacheKey, nextCache);
  } else {
    historyCache = nextCache;
  }

  return result;
};

const readAddressBook = async () => {
  const file = await readAddressBookBuffer();
  return parseAddressBookBuffer(file);
};

const handleRecentTransactions = async (req, res) => {
  try {
    const body = await readJsonBody(req);
    const result = await listRecentPayments(body);
    json(res, 200, result);
  } catch (error) {
    json(res, error.statusCode || 500, {
      found: false,
      message: error.statusCode === 400 ? error.message : '查询最近交易失败，请稍后再试。',
      transactions: [],
      detail: error.message,
    });
  }
};

const handleGetAddressBook = async (res) => {
  try {
    const book = await readAddressBook();
    json(res, 200, book);
  } catch (error) {
    json(res, 500, {
      addresses: [],
      invalidRows: [],
      message: '读取地址名单 Excel 失败。',
      detail: error.message,
    });
  }
};

const handleUploadAddressBook = async (req, res) => {
  try {
    await verifyAdminPassword(req);

    const fileName = decodeURIComponent(String(getHeaderValue(req, 'x-file-name') || 'address-book.xlsx'));
    const contentType = getHeaderValue(req, 'content-type');
    const buffer = await readRequestBuffer(req, ADDRESS_BOOK_UPLOAD_LIMIT);
    const parsed = validateAddressBookUpload({
      buffer,
      fileName,
      contentType,
      maxBytes: ADDRESS_BOOK_UPLOAD_LIMIT,
    });
    const persistence = await persistAddressBookUpload(buffer);

    json(res, 200, {
      message: persistence.mode === 'github'
        ? '名单已上传，正在通过 GitHub 和 Vercel 更新网站。'
        : '名单已更新。',
      addresses: parsed.addresses.length,
      invalidRows: parsed.invalidRows.length,
      persistence,
    });
  } catch (error) {
    json(res, error.statusCode || 500, {
      message: error.statusCode ? error.message : '上传名单失败，请稍后再试。',
    });
  }
};

const handleHistory = async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const result = await listAddressBookHistory({
      selectedAddress: url.searchParams.get('address'),
    });
    json(res, 200, result);
  } catch (error) {
    json(res, 500, {
      transactions: [],
      message: '读取转账历史失败。',
      detail: error.message,
    });
  }
};

const handleCheckTransfer = async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const result = await findTransferByQuery({
      startDate: getQueryValue(url.searchParams, ['startDate', 'start', 'fromDate', '查詢開始日期', '查询开始日期']),
      endDate: getQueryValue(url.searchParams, ['endDate', 'end', 'toDate', '查詢結束日期', '查询结束日期']),
      sender: getQueryValue(url.searchParams, ['sender', 'from', '傳送者', '传送者', '發送者', '发送者']),
      receiver: getQueryValue(url.searchParams, ['receiver', 'to', '接收者']),
      amount: getQueryValue(url.searchParams, ['amount', '金額', '金额']),
    });

    json(res, 200, { status: result });
  } catch (error) {
    json(res, error.statusCode || 500, {
      status: false,
      error: error.message,
    });
  }
};

const handleVersion = async (res) => {
  try {
    json(res, 200, {
      version: await getAppVersion(),
    });
  } catch (error) {
    json(res, 500, {
      version: '',
      message: '读取网站版本失败。',
      detail: error.message,
    });
  }
};

const serveAddressBookFile = async (req, res) => {
  try {
    const data = await readAddressBookBuffer();
    res.writeHead(200, {
      'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'content-disposition': 'attachment; filename="address-book.xlsx"',
      'cache-control': 'no-store',
    });

    if (req.method === 'HEAD') {
      res.end();
      return;
    }

    res.end(data);
  } catch {
    text(res, 404, 'Address book not found');
  }
};

const serveStatic = async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const requestedPath = decodeURIComponent(url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, ''));
  const filePath = join(publicDir, normalize(requestedPath));
  const relativePath = relative(publicDir, filePath);

  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    text(res, 403, 'Forbidden');
    return;
  }

  try {
    const data = await readFile(filePath);
    const type = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.svg': 'image/svg+xml',
    }[extname(filePath)] || 'application/octet-stream';

    res.writeHead(200, {
      'content-type': type,
      'cache-control': 'no-store',
    });

    if (req.method === 'HEAD') {
      res.end();
      return;
    }

    res.end(data);
  } catch {
    text(res, 404, 'Not found');
  }
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'POST' && url.pathname === '/api/recent-transactions') {
    await handleRecentTransactions(req, res);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/address-book') {
    await handleGetAddressBook(res);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/address-book/upload') {
    await handleUploadAddressBook(req, res);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/history') {
    await handleHistory(req, res);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/check-transfer') {
    await handleCheckTransfer(req, res);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/version') {
    await handleVersion(res);
    return;
  }

  if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/address-book.xlsx') {
    await serveAddressBookFile(req, res);
    return;
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    await serveStatic(req, res);
    return;
  }

  text(res, 405, 'Method not allowed');
});

server.listen(PORT, () => {
  console.log(`大锅菜查账专用网 running at http://localhost:${PORT}`);
  console.log(`Address book Excel: ${addressBookPath}`);
});
