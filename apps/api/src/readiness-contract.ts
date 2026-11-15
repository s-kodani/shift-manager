import { z } from "zod";

export const readinessItemIds = ["calendar", "company_policy", "team_config", "staff", "contracts", "planning", "consistency", "history", "preferences"] as const;
export const readinessSection = z.enum(["company", "team", "staff", "demand", "history", "submission", "schedule"]);
export const readinessItem = z.object({
  id: z.enum(readinessItemIds),
  status: z.enum(["complete", "missing", "invalid", "unconfirmed", "warning"]),
  required: z.boolean(),
  message: z.string(),
  section: readinessSection,
  count: z.number().int().nonnegative().optional(),
  code: z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(),
  demandCoverage: z.object({
    expectedSlots: z.number().int().nonnegative(), missingSlots: z.number().int().nonnegative(),
    examples: z.array(z.object({ date: z.string().regex(/^20\d{2}-\d{2}-\d{2}$/),
      start: z.number().int().min(0).max(1440), end: z.number().int().min(0).max(1440), taskId: z.string() }).strict()).max(12),
  }).strict().optional(),
}).strict().refine(item => item.status !== "warning" || item.id === "planning" && item.code === "DEMAND_COVERAGE_MISSING" && !!item.demandCoverage?.missingSlots);
export function readinessBlocksCompute(item: z.infer<typeof readinessItem>) {
  return item.required && item.status !== "complete" && item.status !== "warning";
}
export const readinessResponse = z.object({
  companyId: z.string().uuid(), teamId: z.string().uuid(),
  month: z.string().regex(/^20\d{2}-(0[1-9]|1[0-2])$/),
  inputRevision: z.number().int().nonnegative(),
  draftRevision: z.number().int().nonnegative(),
  canCompute: z.boolean(),
  items: z.array(readinessItem).length(readinessItemIds.length)
    .refine(items => readinessItemIds.every(id => items.filter(item => item.id === id).length === 1)),
}).strict().refine(value => value.canCompute === !value.items.some(readinessBlocksCompute));
export type Readiness = z.infer<typeof readinessResponse>;
export type ReadinessItem = z.infer<typeof readinessItem>;

export const readinessLabels: Record<ReadinessItem["id"], string> = {
  calendar: "企業カレンダー", company_policy: "企業共通ルール・休憩", team_config: "チーム設定",
  staff: "計算対象スタッフ", contracts: "個人契約・雇用区分", planning: "対象月の需要・予定",
  consistency: "入力条件の整合性", history: "月境界の勤務履歴", preferences: "勤務不可・希望（任意）",
};
