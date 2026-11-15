import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from "lucide-react";
import { Button, Field, Input, NativeSelect, Table, TableCell, TableHead } from "./components/ui";

type DatedRow = { date: string; start: string; end: string };
type Filter<T> = { title: string; options: [string, string][]; value: (row: T) => string };

/** View state is independent of the controlled monthly draft, including hidden pages. */
export function PlanningDataTable<T extends DatedRow>({ title, month, rows, rowKey, filters, columns, render, revealKey }: {
  title: string; month: string; rows: T[]; rowKey: (row: T) => string;
  filters: Filter<T>[]; columns: string[];
  render: (row: T, originalIndex: number) => ReactNode; revealKey: string;
}) {
  const [date, setDate] = useState(""), [values, setValues] = useState<string[]>([]);
  const [size, setSize] = useState(25), [page, setPage] = useState(0);
  const editingKey = useRef("");
  const [order, setOrder] = useState("asc");
  const sorted = useMemo(() => rows.map((row, index) => ({ row, index })).sort((a, b) => {
    const comparison = `${a.row.date} ${a.row.start} ${a.row.end}`.localeCompare(`${b.row.date} ${b.row.start} ${b.row.end}`);
    return (order === "asc" ? comparison : -comparison) || a.index - b.index;
  }), [rows, order]);
  const matching = sorted.filter(({ row }) => (!date || row.date === date)
    && filters.every((filter, i) => !values[i] || filter.value(row) === values[i]));
  const pages = Math.max(1, Math.ceil(matching.length / size));
  // Keep the focused row mounted if editing its date/time moves it across pages.
  const editingIndex = matching.findIndex(({ row }) => rowKey(row) === editingKey.current);
  const current = editingIndex < 0 ? Math.min(page, pages - 1) : Math.floor(editingIndex / size);
  useEffect(() => { if (page !== current) setPage(current); }, [page, current]);
  useEffect(() => {
    if (!revealKey) return;
    const index = sorted.findIndex(({ row }) => rowKey(row) === revealKey);
    if (index < 0) return;
    setDate(""); setValues([]); setPage(Math.floor(index / size));
  }, [revealKey]);
  const reset = () => { setDate(""); setValues([]); setPage(0); };
  return <div className="planning-data-table" data-settings-virtual aria-label={`${title}の一覧`}
    onFocusCapture={event => { editingKey.current = (event.target as HTMLElement).closest<HTMLElement>('tr[data-planning-row]')?.dataset.planningRow ?? ""; }}
    onBlurCapture={event => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) editingKey.current = ""; }}>
    <div className="planning-table-filters" data-settings-view>
      <Field title={`${title} 絞り込み日付`} help={null}><Input type="date" min={`${month}-01`} max={`${month}-${new Date(Number(month.slice(0, 4)), Number(month.slice(5)), 0).getDate()}`}
        value={date} onChange={e => { setDate(e.target.value); setPage(0); }} /></Field>
      {filters.map((filter, i) => <Field key={filter.title} title={`${title} 絞り込み${filter.title}`} help={null}>
        <NativeSelect value={values[i] ?? ""} onChange={e => { setValues(old => { const next = [...old]; next[i] = e.target.value; return next; }); setPage(0); }}>
          <option value="">すべて</option>{filter.options.map(([value, name]) => <option key={value} value={value}>{name}</option>)}
        </NativeSelect>
      </Field>)}
      <Field title={`${title} 日時順`} help={null}><NativeSelect value={order} onChange={e => { setOrder(e.target.value); setPage(0); }}>
        <option value="asc">古い順</option><option value="desc">新しい順</option>
      </NativeSelect></Field>
      <Button type="button" onClick={reset}>絞り込みを解除</Button>
    </div>
    <p className="muted">表内で編集できます。絞り込み・ページ外の入力も保存対象です。横に収まらない列は表をスクロールして確認できます。</p>
    <div className="table-scroll planning-table-scroll" role="region" aria-label={`${title}の表（横スクロール可能）`} tabIndex={0}>
      <Table className="planning-table" aria-label={`${title}一覧`}>
        <thead><tr>{columns.map(column => <TableHead scope="col" key={column}>{column}</TableHead>)}</tr></thead>
        <tbody>{matching.slice(current * size, (current + 1) * size).map(({ row, index }) => <tr key={rowKey(row)} data-planning-row={rowKey(row)} aria-label={`${title === "必要人数" ? "需要" : "担当区分の条件"} ${index + 1}`}>{render(row, index)}</tr>)}
          {!matching.length && <tr><TableCell colSpan={columns.length}>{rows.length ? "条件に一致する入力はありません。" : "入力はありません。"}</TableCell></tr>}
        </tbody>
      </Table>
    </div>
    <div className="planning-table-pagination" data-settings-view aria-label={`${title}のページ操作`}>
      <div className="planning-table-page-settings">
        <p role="status">全{rows.length}件{matching.length !== rows.length && `（絞り込み${matching.length}件）`}{" "}<span className="planning-table-page-range">／ {matching.length ? current * size + 1 : 0}〜{Math.min((current + 1) * size, matching.length)}件を表示</span></p>
        <Field title="表示件数" help={null}><NativeSelect aria-label={`${title} 表示件数`} value={size} onChange={e => { setSize(Number(e.target.value)); setPage(0); }}>
          {[25, 50, 100].map(n => <option key={n} value={n}>{n}件</option>)}
        </NativeSelect></Field>
      </div>
      <div className="planning-table-page-navigation">
        <Button type="button" size="icon" aria-label="最初" title="最初" disabled={current === 0} onClick={() => setPage(0)}><ChevronsLeft aria-hidden="true" /></Button>
        <Button type="button" size="icon" aria-label="前へ" title="前へ" disabled={current === 0} onClick={() => setPage(current - 1)}><ChevronLeft aria-hidden="true" /></Button>
        <span className="planning-table-page-number"><span className="sr-only">{current + 1} / {pages}ページ</span><span aria-hidden="true">{current + 1} / {pages}<span className="planning-table-page-suffix">ページ</span></span></span>
        <Button type="button" size="icon" aria-label="次へ" title="次へ" disabled={current === pages - 1} onClick={() => setPage(current + 1)}><ChevronRight aria-hidden="true" /></Button>
        <Button type="button" size="icon" aria-label="最後" title="最後" disabled={current === pages - 1} onClick={() => setPage(pages - 1)}><ChevronsRight aria-hidden="true" /></Button>
      </div>
    </div>
  </div>;
}
