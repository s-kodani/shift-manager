import type { ReactNode } from "react";
import { InfoHelp } from "./components/ui/info-help";

type Help = { tone: "blue" | "amber" | "red" | "gray"; conclusion: string; meaning: ReactNode; example?: ReactNode };
const help: Record<string, Help> = {
  FEASIBLE: {
    tone: "blue",
    conclusion: "シフト案は見つかっていますが、一番よい案かは確認できていません。",
    meaning: <>「未証明」とは、同じ入力条件と優先順位で、<strong>これよりよい案が存在しないとは、まだ言い切れないこと</strong>です。計算時間の上限などで探索を終えると、この状態になることがあります。実際には最良の案である可能性もあります。</>,
    example: <>ほかの優先条件を守ったうえで、希望が<strong>100件中90件</strong>かなう案が見つかりました。<br />ただし、<strong>91件以上</strong>かなう案があるかどうかは、まだ確認できていません。</>,
  },
  OPTIMAL: {
    tone: "blue",
    conclusion: "今回の条件と優先順位では、これよりよい評価の案はありません。",
    meaning: <>不足・希望・余剰などを設定された優先順位で評価し、全段階で最良値を確認できています。<strong>すべての希望がかなうことや、不足がゼロになることを意味するわけではありません。</strong></>,
    example: <>ほかの優先条件を守ると、希望は<strong>100件中90件</strong>までしかかなえられず、<strong>91件以上は不可能</strong>だと確認できた場合です。<br />この場合、10件の希望がかなわなくても、その評価項目では最良です。</>,
  },
  UNKNOWN: {
    tone: "amber",
    conclusion: "今回の探索では、シフト案を見つけられませんでした。",
    meaning: <>条件を満たす案が存在するかどうかは確定していません。<strong>「案を見つけられなかった」と「案が存在しない」は異なります。</strong></>,
    example: <>組み合わせが多く、計算時間の上限までに、必須条件を満たす案を見つけられなかった場合です。<br />まだ調べられていない組み合わせに、有効な案がある可能性は残っています。</>,
  },
  INFEASIBLE: {
    tone: "amber",
    conclusion: "今回の入力条件では、必須条件をすべて満たすシフト案を作れません。",
    meaning: <>組み合わせを変えても必須条件を同時に満たせないことが、計算上確認されています。<strong>同じ条件のまま計算時間を延ばしても、有効な案は得られません。</strong></>,
    example: <>あるスタッフの月最低勤務時間が<strong>100時間</strong>なのに、勤務できる日時をすべて使っても<strong>80時間</strong>までしか働けない場合です。<br />この2つの条件を同時に満たす案は作れません。</>,
  },
  MODEL_INVALID: {
    tone: "red",
    conclusion: "計算の準備段階で問題が見つかり、探索結果を判断できませんでした。",
    meaning: <>シフトを計算するために組み立てたモデルが、検査を通過できなかった状態です。<strong>シフト案が存在しないと確認されたわけではありません。</strong></>,
    example: <>シフト案を探し始める前に、計算モデルの検査エラーで処理が止まった場合です。<br />この状態からは、「作れる」「作れない」のどちらも判断できません。</>,
  },
};
const manual: Help = {
  tone: "gray",
  conclusion: "手動編集した案のため、最良かどうかは確認していません。",
  meaning: <>編集後の案について、ほかの組み合わせとの比較による最適性の確認は行っていません。勤務ルールを満たしているかどうかは、別の「制約検証」で確認します。</>,
  example: <>管理者が、あるスタッフの勤務を<strong>月曜日から火曜日へ変更</strong>した場合です。<br />変更後のルール確認に合格していても、希望や不足の評価まで最良になったとは限りません。</>,
};
const unavailable: Help = {
  tone: "gray",
  conclusion: "この探索状態の説明を表示できません。",
  meaning: "表示されている状態と、制約検証・エラー表示を確認してください。",
};

export function SolverResultHelp({ status, label }: { status?: string; label: string }) {
  const content = status ? Object.hasOwn(help, status) ? help[status] : unavailable : manual;
  return <InfoHelp title="探索結果" variant="result">
    <div className={`solver-help-content solver-help-${content.tone}`}>
      <section className="solver-help-conclusion" aria-label="結論">
        <span className="solver-help-badge">{label}</span>
        <h3>{content.conclusion}</h3>
      </section>
      <p className="solver-help-meaning">{content.meaning}</p>
      {content.example && <section className="solver-help-example" aria-label="説明用の例">
        <h3>説明用の例</h3><p>{content.example}</p>
      </section>}
      <p className="solver-help-guide">勤務ルールの確認結果は『制約検証』タイルで確認してください。</p>
    </div>
  </InfoHelp>;
}
