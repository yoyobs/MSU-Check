import assert from 'node:assert/strict';
import test from 'node:test';
import XLSX from 'xlsx';

import { validateAddressBookUpload } from '../address-book.js';

const validAddress = `0x${'a'.repeat(40)}`;

const buildWorkbookBuffer = (rows, sheetName = '地址名单') => {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  XLSX.utils.book_append_sheet(workbook, sheet, sheetName);
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

test('accepts the address.xlsx template without a header row', () => {
  const secondAddress = `0x${'b'.repeat(40)}`;
  const buffer = buildWorkbookBuffer([
    ['ManhACE', validAddress],
    ['BIG1996', secondAddress],
  ], '工作表1');

  const result = validateAddressBookUpload({
    buffer,
    fileName: 'address.xlsx',
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });

  assert.equal(result.addresses.length, 2);
  assert.equal(result.addresses[0].nickname, 'ManhACE');
  assert.equal(result.addresses[0].address, validAddress);
  assert.equal(result.addresses[1].nickname, 'BIG1996');
  assert.equal(result.addresses[1].address, secondAddress);
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
