export const timeInputPattern = "([01][0-9]|2[0-3])[0-5][0-9]|2400";
export function formatTimeInput(minute: number) {
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}${String(minute % 60).padStart(2, "0")}`;
}
export function parseTimeInput(value: string) {
  if (!/^(?:[01]\d|2[0-3])[0-5]\d$|^2400$/.test(value)) throw new Error("INVALID_TIME");
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(2));
}
export function timeInputError(value: string, stepMinutes = 1, allowEndOfDay = true) {
  if (value === "") return "";
  let minute: number;
  try { minute = parseTimeInput(value); }
  catch { return "時刻は数字4桁のHHMMで入力してください（例：0930）。"; }
  if (!allowEndOfDay && minute === 1440) return "時刻は0000〜2359で入力してください。";
  return minute % stepMinutes ? `時刻は${stepMinutes}分単位で入力してください。` : "";
}
