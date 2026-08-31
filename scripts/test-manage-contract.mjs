import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../manage.html', import.meta.url), 'utf8');
assert.match(source, /data\.code/);
assert.doesNotMatch(source, /data\.error/);
assert.doesNotMatch(source, /data\.message/);
assert.match(source, /capabilityType === 'CANCEL'/);
assert.match(source, /capabilityType === 'RESCHEDULE'/);
assert.match(source, /managementErrorMessage\(data\.code\)/);
console.log('MANAGE_ERROR_CODE_CONTRACT=PASS assertions=6');
