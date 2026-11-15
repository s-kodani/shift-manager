import { expect, it } from 'vitest';
import { compareInputValues, inputChangeCategory, inputChangeTotals } from '../../apps/api/src/input-changes-contract';

it('公開版・公開勤務・計算モードだけを公開の変化に分類し、履歴や固定の変更は入力条件に残す', () => {
  for (const path of [['mode'], ['published', 'staff:2026-10-01', 'shift', 'start'], ['sources', 'published_schedule', 'team']])
    expect(inputChangeCategory({path})).toBe('publication');
  for (const path of [['history', 'staff:2026-09-30'], ['sources', 'published_history', 'staff:2026-09-30'],
    ['sources', 'published_fixed_release', 'release'], ['locks', 'fixed'], ['exceptions', 'reason'],
    ['resources', 'planning', 'team'], ['staff', 'staff', 'rules']]) expect(inputChangeCategory({path})).toBe('input');
});

it.each(['none', 'input', 'publication', 'both'])('カテゴリ別総件数を全差分から数える: %s', mode => {
  const changes = compareInputValues({mode:'draft', demand:1, published:[]}, {
    mode: mode === 'publication' || mode === 'both' ? 'reallocation' : 'draft',
    demand: mode === 'input' || mode === 'both' ? 2 : 1, published:[],
  });
  expect(inputChangeTotals(changes)).toEqual({input: Number(mode === 'input' || mode === 'both'), publication: Number(mode === 'publication' || mode === 'both')});
});

it('ページを超える変更もカテゴリ別総件数から欠落しない', () => {
  const changes = compareInputValues({published:[], demand:[]}, {published:[{staffId:'a', date:'2026-10-01', shift:{start:600}}], demand:Array.from({length:60}, (_, id) => ({id:String(id), direct:0}))});
  const totals = inputChangeTotals(changes);
  expect(changes.length).toBeGreaterThan(50);
  expect(totals.publication).toBe(3);
  expect(totals.input + totals.publication).toBe(changes.length);
});
