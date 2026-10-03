import { describe, expect, test } from 'bun:test';

import { fileStatuses, uploadedFileId } from '../src/providers/deepseek/client.ts';
import { createDeepSeekProvider } from '../src/providers/deepseek/provider.ts';

describe('DeepSeek images', () => {
  test('reads the uploaded file id from the usual answer shapes', () => {
    expect(uploadedFileId({ code: 0, data: { biz_code: 0, biz_data: { id: 'file-1', status: 'PENDING' } } })).toBe('file-1');
    expect(uploadedFileId({ data: { biz_data: { file_id: 'file-2' } } })).toBe('file-2');
    expect(uploadedFileId({ data: { biz_data: {} } })).toBeUndefined();
  });

  test('reads file statuses from a list or a map', () => {
    expect([...fileStatuses({ data: { biz_data: { files: [{ id: 'a', status: 'success' }, { id: 'b', status: 'PENDING' }] } } })]).toEqual([['a', 'SUCCESS'], ['b', 'PENDING']]);
    expect([...fileStatuses({ data: { biz_data: { a: { status: 'PARSE_FAILED' } } } })]).toEqual([['a', 'PARSE_FAILED']]);
  });

  test('marks DeepSeek models as able to read images', () => {
    expect(createDeepSeekProvider({ hasAccount: () => true }).capabilities('deepseek-default').vision).toBeTrue();
  });
});
