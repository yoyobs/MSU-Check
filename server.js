import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, isAbsolute, join, normalize, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual, webcrypto } from 'node:crypto';

const API_BASE = 'https://api-gateway.xangle.io';
const EXPLORER_ORIGIN = 'https://msu-explorer.xangle.io';
const CHAIN = 'NEXON';
const PORT = Number(process.env.PORT || 3000);
const MAX_PAGES = Number(process.env.MAX_PAGES || 20);
const PAGE_SIZE = Number(process.env.PAGE_SIZE || 25);
const BODY_LIMIT = 1024 * 1024;
const IS_VERCEL = Boolean(process.env.VERCEL);
const ADDRESS_BOOK_KEY = process.env.ADDRESS_BOOK_KEY || 'msu-check:address-book';
const KV_REST_API_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
const KV_REST_API_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';

const rootDir = fileURLToPath(new URL('.', import.meta.url));
const publicDir = join(rootDir, 'public');
const dataDir = join(rootDir, 'data');
const addressBookPath = join(dataDir, 'address-book.json');
const adminPasswordPath = join(dataDir, 'admin-password.txt');

let secretCache = {
  key: '',
  expiresAt: 0,
};

let adminPasswordCache = '';

const hasKvStore = () => Boolean(KV_REST_API_URL && KV_REST_API_TOKEN);

const json = (res, status, payload) => {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
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
  const raw = Buffer.concat(chunks).toString('utf8');
  return JSON.parse(raw);
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

const normalizeAmount = (value) => {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return '';

  try {
    const [integerPart, decimalPart = ''] = trimmed.split('.');
    const normalizedInteger = BigInt(integerPart || '0').toString();
    const normalizedDecimal = decimalPart.replace(/0+$/, '');
    return normalizedDecimal ? `${normalizedInteger}.${normalizedDecimal}` : normalizedInteger;
  } catch {
    return trimmed.replace(/\.?0+$/, '');
  }
};

const sameAmount = (a, b) => normalizeAmount(a) === normalizeAmount(b);

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

const findPayment = async ({ sender, receiver, amount }) => {
  const senderAddress = normalizeAddress(sender);
  const receiverAddress = normalizeAddress(receiver);
  const expectedAmount = normalizeAmount(amount);

  if (!senderAddress || !receiverAddress || !expectedAmount) {
    const error = new Error('请先选择发送者、接收者，并填写金额。');
    error.statusCode = 400;
    throw error;
  }

  const checked = {
    pages: 0,
    transactions: 0,
  };

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const data = await explorerPost('/api/address/transaction/list', {
      address: receiverAddress,
      page,
      size: PAGE_SIZE,
    });

    const list = Array.isArray(data.TRXLIST) ? data.TRXLIST : [];
    checked.pages = page;
    checked.transactions += list.length;

    const match = list.find((trx) => {
      const from = normalizeAddress(trx.ADDRSFROMINFO?.ADDR);
      const to = normalizeAddress(trx.ADDRSTOINFO?.ADDR);
      return from === senderAddress && to === receiverAddress && sameAmount(trx.VAL, expectedAmount);
    });

    if (match) {
      return {
        found: true,
        message: '已收到钱',
        transaction: mapTransaction(match),
        checked,
      };
    }

    if (list.length < PAGE_SIZE) break;
  }

  return {
    found: false,
    message: '还没收到钱',
    checked,
  };
};

const ensureDataDir = async () => {
  await mkdir(dataDir, { recursive: true });
};

const kvCommand = async (command) => {
  const response = await fetch(KV_REST_API_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${KV_REST_API_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(command),
  });

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`KV request failed: ${response.status} ${raw}`);
  }

  return JSON.parse(raw);
};

const createId = () => randomBytes(8).toString('hex');

const sanitizeAddressEntry = (entry) => {
  const id = String(entry?.id || createId()).trim();
  const nickname = String(entry?.nickname || '').trim();
  const address = String(entry?.address || '').trim();

  if (!nickname && !address) return null;

  if (!nickname) {
    const error = new Error('昵称不能为空。');
    error.statusCode = 400;
    throw error;
  }

  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    const error = new Error(`地址格式不正确：${address || '空地址'}`);
    error.statusCode = 400;
    throw error;
  }

  return {
    id: id || createId(),
    nickname: nickname.slice(0, 80),
    address,
  };
};

const sanitizeAddressBook = (addresses) => {
  if (!Array.isArray(addresses)) {
    const error = new Error('地址列表格式不正确。');
    error.statusCode = 400;
    throw error;
  }

  const used = new Set();
  return addresses
    .map(sanitizeAddressEntry)
    .filter(Boolean)
    .map((item) => {
      let id = item.id;
      while (used.has(id)) id = createId();
      used.add(id);
      return { ...item, id };
    });
};

const readAddressBook = async () => {
  if (hasKvStore()) {
    const data = await kvCommand(['GET', ADDRESS_BOOK_KEY]);

    if (data.result) {
      return {
        addresses: sanitizeAddressBook(JSON.parse(data.result).addresses || []),
      };
    }
  }

  try {
    const raw = await readFile(addressBookPath, 'utf8');
    const data = JSON.parse(raw);
    return {
      addresses: sanitizeAddressBook(data.addresses || []),
    };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;

    const emptyBook = { addresses: [] };
    if (IS_VERCEL) return emptyBook;

    await writeAddressBook(emptyBook.addresses);
    return emptyBook;
  }
};

const writeAddressBook = async (addresses) => {
  const book = {
    addresses: sanitizeAddressBook(addresses),
    updatedAt: new Date().toISOString(),
  };

  if (hasKvStore()) {
    await kvCommand(['SET', ADDRESS_BOOK_KEY, JSON.stringify(book)]);
    return book;
  }

  if (IS_VERCEL) {
    const error = new Error('Vercel 线上环境不能直接写入项目文件，请先配置 Upstash Redis / Vercel KV 环境变量。');
    error.statusCode = 501;
    throw error;
  }

  await ensureDataDir();
  await writeFile(addressBookPath, `${JSON.stringify(book, null, 2)}\n`, 'utf8');
  return book;
};

const getAdminPassword = async () => {
  if (process.env.ADMIN_PASSWORD) return process.env.ADMIN_PASSWORD;
  if (adminPasswordCache) return adminPasswordCache;

  if (IS_VERCEL) return '';

  await ensureDataDir();

  try {
    const password = (await readFile(adminPasswordPath, 'utf8')).trim();
    if (password) {
      adminPasswordCache = password;
      return password;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  adminPasswordCache = randomBytes(18).toString('base64url');
  await writeFile(adminPasswordPath, `${adminPasswordCache}\n`, 'utf8');
  return adminPasswordCache;
};

const safeEqual = (a, b) => {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && timingSafeEqual(left, right);
};

const requireAdmin = async (req) => {
  const expected = await getAdminPassword();
  if (!expected) return false;

  const provided = req.headers['x-admin-password'];
  return safeEqual(provided, expected);
};

const handleSearch = async (req, res) => {
  try {
    const body = await readJsonBody(req);
    const result = await findPayment(body);
    json(res, 200, result);
  } catch (error) {
    json(res, error.statusCode || 500, {
      found: false,
      message: error.statusCode === 400 ? error.message : '查询失败，请稍后再试。',
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
      message: '读取地址列表失败。',
      detail: error.message,
    });
  }
};

const handleSaveAddressBook = async (req, res) => {
  try {
    if (!(await requireAdmin(req))) {
      json(res, 401, {
        message: IS_VERCEL && !process.env.ADMIN_PASSWORD
          ? '请先在 Vercel 环境变量设置 ADMIN_PASSWORD。'
          : '管理密码不正确。',
      });
      return;
    }

    const body = await readJsonBody(req);
    const book = await writeAddressBook(body.addresses || []);
    json(res, 200, {
      ...book,
      message: '地址列表已保存。',
    });
  } catch (error) {
    json(res, error.statusCode || 500, {
      message: error.statusCode ? error.message : '保存地址列表失败。',
      detail: error.message,
    });
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

  if (req.method === 'POST' && url.pathname === '/api/search') {
    await handleSearch(req, res);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/address-book') {
    await handleGetAddressBook(res);
    return;
  }

  if (req.method === 'PUT' && url.pathname === '/api/admin/address-book') {
    await handleSaveAddressBook(req, res);
    return;
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    await serveStatic(req, res);
    return;
  }

  text(res, 405, 'Method not allowed');
});

server.listen(PORT, async () => {
  await getAdminPassword();
  console.log(`MSU payment checker running at http://localhost:${PORT}`);
  console.log(`Admin page: http://localhost:${PORT}/admin.html`);

  if (process.env.ADMIN_PASSWORD) {
    console.log('Admin password: configured by ADMIN_PASSWORD environment variable');
  } else if (IS_VERCEL) {
    console.log('Admin password: set ADMIN_PASSWORD in Vercel environment variables');
  } else {
    console.log(`Admin password file: ${adminPasswordPath}`);
  }
});
