import XLSX from 'xlsx';

export const DEFAULT_ADDRESS_BOOK_UPLOAD_LIMIT_BYTES = 2 * 1024 * 1024;

const allowedUploadContentTypes = new Set([
  '',
  'application/octet-stream',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

const createAddressBookError = (message, statusCode = 400) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
};

export const sanitizeAddressEntry = (entry, rowNumber) => {
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

export const parseAddressBookBuffer = (buffer) => {
  let workbook;

  try {
    workbook = XLSX.read(buffer, { type: 'buffer' });
  } catch {
    throw createAddressBookError('名单 Excel 解析失败，请上传有效的 .xlsx 文件。', 400);
  }

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

export const validateAddressBookUpload = ({
  buffer,
  fileName,
  contentType = '',
  maxBytes = DEFAULT_ADDRESS_BOOK_UPLOAD_LIMIT_BYTES,
}) => {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw createAddressBookError('上传文件为空。', 400);
  }

  if (buffer.length > maxBytes) {
    throw createAddressBookError(`名单文件不能超过 ${Math.floor(maxBytes / 1024 / 1024)} MB。`, 413);
  }

  const normalizedFileName = String(fileName || '').trim().toLowerCase();
  if (!normalizedFileName.endsWith('.xlsx')) {
    throw createAddressBookError('只支持上传 .xlsx 名单文件。', 400);
  }

  const normalizedContentType = String(contentType || '').split(';')[0].trim().toLowerCase();
  if (!allowedUploadContentTypes.has(normalizedContentType)) {
    throw createAddressBookError('名单文件类型不正确，请上传 .xlsx 文件。', 400);
  }

  if (buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
    throw createAddressBookError('名单文件不是有效的 .xlsx 文件。', 400);
  }

  const parsed = parseAddressBookBuffer(buffer);

  if (!parsed.addresses.length) {
    throw createAddressBookError('名单里没有有效地址。', 400);
  }

  if (parsed.invalidRows.length) {
    const rowNumbers = parsed.invalidRows.slice(0, 5).map((row) => row.rowNumber).join('、');
    throw createAddressBookError(`名单包含无效行，请检查第 ${rowNumbers} 行。`, 400);
  }

  return parsed;
};
