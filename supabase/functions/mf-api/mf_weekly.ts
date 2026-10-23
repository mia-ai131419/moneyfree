// moneyfree 每週報表:上週(台灣時間週一 00:00 ~ 週日 23:59)誰做了健康/財務檢測、分數與結果
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.45.4";

const MF_DIM_KEYS = ["flex", "stress", "ret", "health", "growth"];
const MF_TZ_MS = 8 * 3600e3; // Asia/Taipei
const MF_CARD_ROWS = 10;
const MF_LIFF_FULL = "2011977982-Oqw2Ao0M";

export type MfWeekRow = { name: string; total: number; result: string; at: string };
export type MfWeekData = { from: string; to: string; health: MfWeekRow[]; quiz: MfWeekRow[] };

// 本週一 00:00(台灣)往前 7 天
export function mfLastWeekRange(now = new Date()) {
  const tw = new Date(now.getTime() + MF_TZ_MS);
  const daysSinceMon = (tw.getUTCDay() + 6) % 7;
  const monTw = Date.UTC(tw.getUTCFullYear(), tw.getUTCMonth(), tw.getUTCDate() - daysSinceMon);
  const to = new Date(monTw - MF_TZ_MS);
  return { from: new Date(to.getTime() - 7 * 86400e3), to };
}

export async function mfWeeklyData(db: SupabaseClient, now = new Date()): Promise<MfWeekData> {
  const { from, to } = mfLastWeekRange(now);
  const [health, quiz, users] = await Promise.all([
    db.from("mf_health_checks").select("line_user_id,total,summary,created_at")
      .gte("created_at", from.toISOString()).lt("created_at", to.toISOString()).order("created_at", { ascending: false }),
    db.from("mf_money_quiz").select("line_user_id,dims,persona,created_at")
      .gte("created_at", from.toISOString()).lt("created_at", to.toISOString()).order("created_at", { ascending: false }),
    db.from("mf_users").select("line_user_id,display_name"),
  ]);
  const nameOf = new Map((users.data || []).map((u) => [u.line_user_id, u.display_name || u.line_user_id.slice(-6)]));
  const name = (id: string) => nameOf.get(id) || id.slice(-6);
  return {
    from: from.toISOString(), to: to.toISOString(),
    health: (health.data || []).map((h) => ({ name: name(h.line_user_id), total: h.total || 0, result: h.summary || "", at: h.created_at })),
    quiz: (quiz.data || []).map((q) => {
      const dims = (q.dims || {}) as Record<string, number>;
      const total = Math.round(MF_DIM_KEYS.reduce((s, k) => s + (Number(dims[k]) || 0), 0) / MF_DIM_KEYS.length);
      return { name: name(q.line_user_id), total, result: q.persona || "", at: q.created_at };
    }),
  };
}

function mfDay(iso: string) {
  return new Date(new Date(iso).getTime() + MF_TZ_MS).toISOString().slice(5, 10).replace("-", "/");
}

function mfAvg(rows: MfWeekRow[]) {
  return rows.length ? Math.round(rows.reduce((s, r) => s + r.total, 0) / rows.length) : "-";
}

function mfSection(title: string, rows: MfWeekRow[]) {
  const head = { type: "box", layout: "horizontal", margin: "lg", contents: [
    { type: "text", text: title, weight: "bold", size: "md", color: "#22324D", flex: 6 },
    { type: "text", text: `${rows.length} 人次・平均 ${mfAvg(rows)}`, size: "xs", color: "#5B6573", align: "end", gravity: "center", flex: 5 },
  ] };
  if (!rows.length) return [head, { type: "text", text: "本週無新檢測", size: "sm", color: "#5B6573", margin: "sm" }];
  const lines = rows.slice(0, MF_CARD_ROWS).map((r) => ({ type: "box", layout: "horizontal", margin: "sm", contents: [
    { type: "text", text: r.name, size: "sm", color: "#22324D", flex: 4, wrap: true },
    { type: "text", text: String(r.total), size: "sm", weight: "bold", color: "#9C7C14", align: "center", flex: 2 },
    { type: "text", text: r.result || "-", size: "xs", color: "#5B6573", flex: 6, wrap: true, maxLines: 2 },
  ] }));
  const more = rows.length > MF_CARD_ROWS
    ? [{ type: "text", text: `…另有 ${rows.length - MF_CARD_ROWS} 筆,請看完整表格`, size: "xs", color: "#5B6573", margin: "sm" }]
    : [];
  return [head, { type: "separator", margin: "sm" }, ...lines, ...more];
}

export function mfWeeklyCard(d: MfWeekData) {
  const range = `${mfDay(d.from)} ~ ${mfDay(new Date(new Date(d.to).getTime() - 1).toISOString())}`;
  return {
    type: "flex",
    altText: `【每週檢測報表】${range} 健康 ${d.health.length} 人次、財務 ${d.quiz.length} 人次`,
    contents: {
      type: "bubble", size: "giga",
      header: { type: "box", layout: "vertical", backgroundColor: "#C9A227", paddingAll: "16px", contents: [
        { type: "text", text: "每週檢測報表", weight: "bold", size: "xl", color: "#22324D" },
        { type: "text", text: range, size: "sm", color: "#22324D", margin: "sm" },
      ] },
      body: { type: "box", layout: "vertical", paddingAll: "16px", contents: [
        ...mfSection("健康大數據檢測", d.health),
        ...mfSection("財務健康度檢測", d.quiz),
      ] },
      footer: { type: "box", layout: "vertical", paddingAll: "12px", contents: [
        { type: "button", style: "primary", color: "#C9A227", height: "sm",
          action: { type: "uri", label: "看完整表格", uri: `https://liff.line.me/${MF_LIFF_FULL}/owner_report.html?week=1` } },
      ] },
    },
  };
}

// 排程呼叫:驗證排程密鑰(存在 mf_settings.weekly_cron_key)後推給擁有者
export async function mfWeeklyPush(db: SupabaseClient, cronKey: string) {
  const { data: key } = await db.from("mf_settings").select("value").eq("key", "weekly_cron_key").maybeSingle();
  if (!key?.value || cronKey !== key.value) return { status: 401, body: { error: "unauthorized" } };
  const { data: owner } = await db.from("mf_users").select("line_user_id").eq("is_owner", true).maybeSingle();
  if (!owner) return { status: 404, body: { error: "未設定擁有者" } };
  const data = await mfWeeklyData(db);
  const r = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${Deno.env.get("LINE_TOKEN")}` },
    body: JSON.stringify({ to: owner.line_user_id, messages: [mfWeeklyCard(data)] }),
  });
  if (!r.ok) console.error("weekly push failed", r.status, await r.text());
  return { status: r.ok ? 200 : 502, body: { ok: r.ok, health: data.health.length, quiz: data.quiz.length } };
}
