// moneyfree LIFF 後端 API:驗證 LINE ID Token 後處理健康檢測、財務測驗、個人資訊
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const MF_LIFF_CHANNEL_ID = "2011977982";
const MF_OPENAI_MODEL = "gpt-4o-mini";
const mfDb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

const MF_CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// 15 項外觀觀察與權重(合計 100)
const MF_HEALTH_ITEMS: [string, string, number][] = [
  ["complexion", "氣色紅潤度", 10], ["tone_even", "膚色均勻度", 8], ["radiance", "皮膚光澤度", 7],
  ["eye_energy", "眼神精神度", 10], ["dark_circles", "黑眼圈改善度(越少分數越高)", 8],
  ["eye_puffiness", "眼周浮腫改善度(越少分數越高)", 6], ["lip_color", "唇色健康度", 6],
  ["face_puffiness", "臉部浮腫改善度(越少分數越高)", 6], ["fatigue_lines", "疲勞紋改善度(越少分數越高)", 5],
  ["blemish", "痘痘泛紅改善度(越少分數越高)", 6], ["relaxation", "表情放鬆度", 7],
  ["posture", "臉部對稱與姿態", 4], ["hair", "頭髮光澤度", 5], ["hydration", "皮膚水潤度", 6],
  ["vitality", "整體活力感", 6],
];

const MF_PERSONAL_KEYS = [
  "name", "phone", "age", "job", "family", "dependents", "income", "side_income", "expense", "saving_rate",
  "cash", "stocks", "funds", "insurance_saving", "real_estate", "other_assets", "mortgage", "car_loan",
  "card_debt", "protection", "goals", "risk", "experience", "contact_time", "notes",
];
const MF_DIM_KEYS = ["flex", "stress", "ret", "health", "growth"];

function mfJson(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...MF_CORS, "Content-Type": "application/json" } });
}

function mfMonth() {
  return new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 7); // 台灣時間 YYYY-MM
}

async function mfVerify(idToken: string) {
  const r = await fetch("https://api.line.me/oauth2/v2.1/verify", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ id_token: idToken, client_id: MF_LIFF_CHANNEL_ID }),
  });
  if (!r.ok) return null;
  const d = await r.json();
  return d.sub ? { userId: d.sub as string, name: (d.name as string) || "" } : null;
}

async function mfAnalyzeFace(image: string) {
  const itemsText = MF_HEALTH_ITEMS.map(([k, label]) => `${k}: ${label}`).join("\n");
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${Deno.env.get("OPENAI_API_KEY")}` },
    body: JSON.stringify({
      model: MF_OPENAI_MODEL,
      response_format: { type: "json_object" },
      temperature: 0.3,
      messages: [
        {
          role: "system",
          content: `你是健康管理顧問,依照片做「外觀氣色觀察」,不是醫療診斷,不可提及任何疾病名稱。
用繁體中文(台灣用語),語氣溫暖、清楚、簡短。每項 0–100 分,分數越高代表狀態越好。
觀察項目:
${itemsText}
只輸出 JSON:{"face_detected":true/false,"scores":{項目代號:整數},"notes":{項目代號:"15 字內觀察"},"summary":"60 字內總評","tips":["3 條生活建議,每條 30 字內"]}
若照片中沒有清楚的人臉,face_detected 設為 false,其他欄位可省略。`,
        },
        { role: "user", content: [{ type: "image_url", image_url: { url: image, detail: "low" } }] },
      ],
    }),
  });
  if (!r.ok) throw new Error(`AI 服務錯誤(${r.status})`);
  const d = await r.json();
  return JSON.parse(d.choices?.[0]?.message?.content || "{}");
}

async function mfHandle(action: string, body: Record<string, unknown>, user: { userId: string; name: string }) {
  const uid = user.userId;
  switch (action) {
    case "health_status": {
      const { data } = await mfDb.from("mf_health_checks").select("*").eq("line_user_id", uid).eq("month", mfMonth()).maybeSingle();
      return mfJson({ record: data });
    }
    case "health_submit": {
      const month = mfMonth();
      const { data: existing } = await mfDb.from("mf_health_checks").select("*").eq("line_user_id", uid).eq("month", month).maybeSingle();
      if (existing) return mfJson({ error: "本月已完成檢測,下個月再來喔", record: existing }, 409);
      const image = String(body.image || "");
      if (!/^data:image\/(jpeg|png|webp);base64,/.test(image) || image.length > 3_000_000) {
        return mfJson({ error: "照片格式不正確或檔案太大" }, 400);
      }
      const ai = await mfAnalyzeFace(image);
      if (!ai.face_detected) return mfJson({ error: "沒有偵測到清楚的正臉,請在光線充足處重新拍攝" }, 422);
      const scores: Record<string, number> = {};
      const notes: Record<string, string> = {};
      let total = 0;
      for (const [k, , w] of MF_HEALTH_ITEMS) {
        const v = Math.max(0, Math.min(100, Math.round(Number(ai.scores?.[k]) || 0)));
        scores[k] = v;
        notes[k] = String(ai.notes?.[k] || "").slice(0, 40);
        total += (v * w) / 100;
      }
      const summary = String(ai.summary || "").slice(0, 200);
      const tips = (Array.isArray(ai.tips) ? ai.tips : []).slice(0, 3).map((t: unknown) => String(t).slice(0, 80));
      const { data, error } = await mfDb.from("mf_health_checks").insert({
        line_user_id: uid, month, total: Math.round(total), summary, scores: { scores, notes, tips, summary },
      }).select().single();
      if (error) return mfJson({ error: "本月已完成檢測" }, 409);
      return mfJson({ record: data });
    }
    case "quiz_submit": {
      const answers = Array.isArray(body.answers) ? body.answers.slice(0, 20).map((n) => Number(n) || 0) : [];
      const rawDims = (body.dims || {}) as Record<string, unknown>;
      const dims: Record<string, number> = {};
      for (const k of MF_DIM_KEYS) dims[k] = Math.max(0, Math.min(100, Math.round(Number(rawDims[k]) || 0)));
      const persona = String(body.persona || "").slice(0, 20);
      const { error } = await mfDb.from("mf_money_quiz").insert({ line_user_id: uid, answers, dims, persona });
      if (error) return mfJson({ error: "儲存失敗" }, 500);
      return mfJson({ ok: true });
    }
    case "quiz_latest": {
      const { data } = await mfDb.from("mf_money_quiz").select("*").eq("line_user_id", uid)
        .order("created_at", { ascending: false }).limit(1).maybeSingle();
      return mfJson({ record: data });
    }
    case "personal_get": {
      const { data } = await mfDb.from("mf_personal_info").select("*").eq("line_user_id", uid).maybeSingle();
      return mfJson({ record: data });
    }
    case "personal_save": {
      const raw = (body.data || {}) as Record<string, unknown>;
      const data: Record<string, string> = {};
      for (const k of MF_PERSONAL_KEYS) {
        if (raw[k] !== undefined && raw[k] !== null) data[k] = String(raw[k]).trim().slice(0, 500);
      }
      if (!data.name || !data.phone) return mfJson({ error: "請填寫姓名與聯絡電話" }, 400);
      const { error } = await mfDb.from("mf_personal_info").upsert({ line_user_id: uid, data, updated_at: new Date().toISOString() });
      if (error) return mfJson({ error: "儲存失敗" }, 500);
      return mfJson({ ok: true });
    }
    default:
      return mfJson({ error: "未知的操作" }, 400);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: MF_CORS });
  if (req.method !== "POST") return mfJson({ error: "Method not allowed" }, 405);
  try {
    const body = await req.json();
    const user = await mfVerify(String(body.idToken || ""));
    if (!user) return mfJson({ error: "登入已失效,請關閉後重新開啟" }, 401);
    await mfDb.from("mf_users").upsert(
      { line_user_id: user.userId, display_name: user.name || null, last_seen: new Date().toISOString() },
      { onConflict: "line_user_id", ignoreDuplicates: false },
    );
    return await mfHandle(String(body.action || ""), body, user);
  } catch (e) {
    console.error("mf-api error", e);
    return mfJson({ error: "系統忙碌中,請稍後再試" }, 500);
  }
});
