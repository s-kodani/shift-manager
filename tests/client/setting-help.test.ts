import { expect, it } from 'vitest';
import { settingHelp } from '../../apps/web/product/setting-help';
it('explains high-risk distinctions without treating zero as unset or the deadline as the target month', () => {
  expect(settingHelp('需要 3 直接必要人数（空欄＝未設定）')).toContain('0は「必要なし」');
  expect(settingHelp('毎月の希望締切日')).toContain('対象月の前月');
  expect(settingHelp('休憩が必要になる勤務時間（分・超過時）')).toContain('ちょうど6時間は対象外');
});
it('provides context for dynamic staff, history, proficiency and role fields', () => {
  expect(settingHelp('勤務時間(分)')).toContain('未確認の日は空欄');
  expect(settingHelp('確認の根拠')).toContain('何で確認');
  expect(settingHelp('電話（最低習熟度 2）')).toContain('未登録');
  expect(settingHelp('熟練 の能力係数')).toContain('0.5');
  expect(settingHelp('担当区分の条件 2 比率の分母')).toContain('分子0・分母1');
  expect(settingHelp('電話 → 受付（分）')).toContain('逆方向とは別');
});
it('does not invent explanations for unknown labels', () => {
  expect(settingHelp('未知の項目')).toBeUndefined();
});
it('distinguishes demand and role bulk input rules and explicit saving', () => {
  expect(settingHelp('一括入力 毎日の開始')).toContain('配置枠');
  expect(settingHelp('担当区分一括入力 毎日の開始')).toContain('60分でも30分単位');
  expect(settingHelp('一括入力 直接必要人数')).toContain('空欄は未入力のため反映できません');
  expect(settingHelp('一括入力 既存の枠')).toContain('算出値は保持');
  expect(settingHelp('担当区分一括入力 既存の条件')).toContain('一部だけ時間が重なる');
  expect(settingHelp('担当区分一括入力 最低人数')).toContain('大きい方');
  expect(settingHelp('担当区分一括入力 比率の分子')).toContain('分子0・分母1');
  expect(settingHelp('担当区分一括入力 比率の分母')).toContain('SV・リーダーは人数の分母から除き');
  expect(settingHelp('期間を指定して必要人数の一括入力')).toContain('「必要人数を保存」');
  expect(settingHelp('期間を指定して担当区分の条件を一括入力')).toContain('「担当区分の必要人数を保存」');
});
