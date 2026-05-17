import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, isAbsolute, join, normalize, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, webcrypto } from 'node:crypto';
import XLSX from 'xlsx';

const API_BASE = 'https://api-gateway.xangle.io';
const EXPLORER_ORIGIN = 'https://msu-explorer.xangle.io';
const CHAIN = 'NEXON';
const PORT = Number(process.env.PORT || 3000);
const MAX_PAGES = Number(process.env.MAX_PAGES || 20);
const PAGE_SIZE = Number(process.env.PAGE_SIZE || 25);
const RECENT_LIMIT = 2;
const HISTORY_LIMIT = 30;
const HISTORY_PAGE_LIMIT = 2;
const BODY_LIMIT = 1024 * 1024;

const rootDir = fileURLToPath(new URL('.', import.meta.url));
const publicDir = join(rootDir, 'public');
const addressBookPath = join(rootDir, 'data', 'address-book.xlsx');

let appVersionCache = {
  value: '',
  expiresAt: 0,
};

let secretCache = {
  key: '',
  expiresAt: 0,
};

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

const readJsonBody = async (req) => {
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;
    if (size > BODY_LIMIT) {
      const error = new Error('请求内容太大。');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }

  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
};

const getAppVersion = async () => {
  if (appVersionCache.value && Date.now() < appVersionCache.expiresAt) {
    return appVersionCache.value;
  }

  const files = [
    join(rootDir, 'server.js'),
    join(rootDir, 'package.json'),
    join(publicDir, 'index.html'),
    addressBookPath,
  ];
  const hash = createHash('sha256');

  for (const file of files) {
    try {
      hash.update(await readFile(file));
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

const listRecentPayments = async ({ sender, receiver }) => {
  const senderAddress = normalizeAddress(sender);
  const receiverAddress = normalizeAddress(receiver);

  if (!senderAddress || !receiverAddress) {
    const error = new Error('请先选择发送者和接收者。');
    error.statusCode = 400;
    throw error;
  }

  const checked = {
    pages: 0,
    transactions: 0,
  };
  const matches = [];

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const data = await explorerPost('/api/address/transaction/list', {
      address: receiverAddress,
      page,
      size: PAGE_SIZE,
    });

    const list = Array.isArray(data.TRXLIST) ? data.TRXLIST : [];
    checked.pages = page;
    checked.transactions += list.length;

    for (const trx of list) {
      const from = normalizeAddress(trx.ADDRSFROMINFO?.ADDR);
      const to = normalizeAddress(trx.ADDRSTOINFO?.ADDR);

      if (from === senderAddress && to === receiverAddress) {
        matches.push(mapTransaction(trx));
        if (matches.length >= RECENT_LIMIT) break;
      }
    }

    if (matches.length >= RECENT_LIMIT || list.length < PAGE_SIZE) break;
  }

  return {
    found: matches.length > 0,
    message: matches.length ? '已找到最近交易' : '还没收到钱',
    transactions: matches,
    checked,
  };
};

const listAddressBookHistory = async () => {
  const { addresses } = await readAddressBook();
  const lookup = buildAddressLookup(addresses);
  const addressSet = new Set(lookup.keys());

  if (addressSet.size < 2) {
    return {
      transactions: [],
      checked: {
        addresses: addressSet.size,
        pages: 0,
        transactions: 0,
      },
    };
  }

  const checked = {
    addresses: addressSet.size,
    pages: 0,
    transactions: 0,
  };
  const byHash = new Map();

  for (const item of addresses) {
    const address = normalizeAddress(item.address);

    for (let page = 1; page <= HISTORY_PAGE_LIMIT; page += 1) {
      const data = await explorerPost('/api/address/transaction/list', {
        address,
        page,
        size: PAGE_SIZE,
      });

      const list = Array.isArray(data.TRXLIST) ? data.TRXLIST : [];
      checked.pages += 1;
      checked.transactions += list.length;

      for (const trx of list) {
        const from = normalizeAddress(trx.ADDRSFROMINFO?.ADDR);
        const to = normalizeAddress(trx.ADDRSTOINFO?.ADDR);

        if (from && to && from !== to && addressSet.has(from) && addressSet.has(to)) {
          const transaction = withBookNames(mapTransaction(trx), lookup);
          byHash.set(transaction.hash, transaction);
        }
      }

      if (list.length < PAGE_SIZE) break;
    }
  }

  const transactions = Array.from(byHash.values())
    .sort((a, b) => (Number(b.timestamp) || 0) - (Number(a.timestamp) || 0))
    .slice(0, HISTORY_LIMIT);

  return {
    transactions,
    checked,
  };
};

const sanitizeAddressEntry = (entry, rowNumber) => {
  const nickname = String(entry?.nickname || '').trim();
  const address = String(entry?.address || '').trim();

  if (!nickname && !address) return null;

  if (!nickname || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return {
      invalid: true,
      rowNumber,
      nickname,
      address,
    };
  }

  return {
    id: `${rowNumber}-${address.toLowerCase()}`,
    nickname: nickname.slice(0, 80),
    address,
  };
};

const readAddressBook = async () => {
  const file = await readFile(addressBookPath);
  const workbook = XLSX.read(file, { type: 'buffer' });
  const sheetName = workbook.Sheets['地址名单'] ? '地址名单' : workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];

  if (!sheet) {
    return { addresses: [], invalidRows: [] };
  }

  const rows = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    raw: false,
    defval: '',
  });

  const parsed = rows.slice(1).map((row, index) => sanitizeAddressEntry({
    nickname: row[0],
    address: row[1],
  }, index + 2));

  return {
    addresses: parsed.filter((item) => item && !item.invalid),
    invalidRows: parsed.filter((item) => item?.invalid),
  };
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

const handleHistory = async (res) => {
  try {
    const result = await listAddressBookHistory();
    json(res, 200, result);
  } catch (error) {
    json(res, 500, {
      transactions: [],
      message: '读取转账历史失败。',
      detail: error.message,
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
    const data = await readFile(addressBookPath);
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

  if (req.method === 'GET' && url.pathname === '/api/history') {
    await handleHistory(res);
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
