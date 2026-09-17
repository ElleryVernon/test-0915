import test from 'node:test';
import assert from 'node:assert/strict';
import { topupAmount } from '../src/lib/point-topup';
test('topup accepts whole won at 1:1 within explicit limits', () => {
 for (const raw of ['1000','5000','100000']) assert.equal(topupAmount(raw),Number(raw));
 for (const raw of ['', '0','999','100001','1.5','-5000','Infinity',' 5000','5000x']) assert.equal(topupAmount(raw),null,raw);
});
