import assert from 'node:assert/strict';
import test from 'node:test';
import XLSX from 'xlsx';

import { validateAddressBookUpload } from '../address-book.js';

const validAddress = `0x${'a'.repeat(40)}`;

const buildWorkbookBuffer = (rows) => {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  XLSX.utils.book_append_sheet(workbook, sheet, '地址名单');
  return Buffer.from(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }));
};

test('validates an uploaded xlsx address book', () => {
  const buffer = buildWorkbookBuffer([
    ['昵称', '地址'],
    ['测试成员', validAddress],
  ]);

  const result = validateAddressBookUpload({
    buffer,
    fileName: 'members.xlsx',
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });

  assert.equal(result.addresses.length, 1);
  assert.equal(result.addresses[0].nickname, '测试成员');
  assert.equal(result.addresses[0].address, validAddress);
});

test('rejects uploads without an xlsx extension', () => {
  const buffer = buildWorkbookBuffer([
    ['昵称', '地址'],
    ['测试成员', validAddress],
  ]);

  assert.throws(() => {
    validateAddressBookUpload({
      buffer,
      fileName: 'members.csv',
      contentType: 'text/csv',
    });
  }, /只支持上传 \.xlsx 名单文件/);
});

test('rejects address books with no valid rows', () => {
  const buffer = buildWorkbookBuffer([
    ['昵称', '地址'],
    ['地址错误', 'not-an-address'],
  ]);

  assert.throws(() => {
    validateAddressBookUpload({
      buffer,
      fileName: 'members.xlsx',
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
  }, /名单里没有有效地址/);
});
