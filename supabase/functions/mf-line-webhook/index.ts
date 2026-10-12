// moneyfree LINE Webhook:驗證簽章、綁定擁有者、建立圖文選單、只對擁有者提供 AI 助理
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const MF_OPENAI_MODEL = "gpt-4o-mini";
const MF_SITE = "https://mia-ai131419.github.io/moneyfree";
const MF_LIFF_HALF = "2011977982-TKjnvFHN";
const MF_LIFF_FULL = "2011977982-Oqw2Ao0M";
const MF_CONTACT = "https://line.me/ti/p/KSNRRjbtdx";
const MF_MENU_NAME = "moneyfree-main";
const mfToken = Deno.env.get("LINE_TOKEN") || "";
const mfSecret = Deno.env.get("LINE_secret") || "";
const mfDb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

async function mfVerifySignature(raw: string, signature: string | null) {
  if (!signature || !mfSecret) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(mfSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw));
  const expected = btoa(String.fromCharCode(...new Uint8Array(sig)));
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

function mfLine(path: string, init: RequestInit = {}, host = "api.line.me") {
  return fetch(`https://${host}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${mfToken}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
}

async function mfReply(replyToken: string, text: string) {
  await mfLine("/v2/bot/message/reply", {
    method: "POST",
    body: JSON.stringify({ replyToken, messages: [{ type: "text", text: text.slice(0, 4900) }] }),
  });
}

async function mfSetupRichMenu() {
  const list = await (await mfLine("/v2/bot/richmenu/list")).json();
  for (const m of list.richmenus || []) {
    if (m.name === MF_MENU_NAME) await mfLine(`/v2/bot/richmenu/${m.richMenuId}`, { method: "DELETE" });
  }
  const area = (x: number, y: number, uri: string, label: string) => ({
    bounds: { x, y, width: 1250, height: 843 }, action: { type: "uri", label, uri },
  });
  const created = await mfLine("/v2/bot/richmenu", {
    method: "POST",
    body: JSON.stringify({
      size: { width: 2500, height: 1686 }, selected: true, name: MF_MENU_NAME, chatBarText: "服務選單",
      areas: [
        area(0, 0, `https://liff.line.me/${MF_LIFF_HALF}/health_detect.html`, "健康大數據檢測"),
        area(1250, 0, `https://liff.line.me/${MF_LIFF_HALF}/money_health.html`, "財務健康度檢測"),
        area(0, 843, `https://liff.line.me/${MF_LIFF_FULL}/personal_info.html`, "個人資訊填寫"),
        area(1250, 843, MF_CONTACT, "聯絡專員"),
      ],
    }),
  });
  const { richMenuId } = await created.json();
  if (!richMenuId) throw new Error("建立選單失敗");
  const img = await fetch(`${MF_SITE}/assets/richmenu.jpg`);
  if (!img.ok) throw new Error("選單圖片下載失敗");
  const up = await mfLine(`/v2/bot/richmenu/${richMenuId}/content`, {
    method: "POST", headers: { "Content-Type": "image/jpeg" }, body: await img.arrayBuffer(),
  }, "api-data.line.me");
  if (!up.ok) throw new Error(`上傳選單圖片失敗(${up.status})`);
  await mfLine(`/v2/bot/user/all/richmenu/${richMenuId}`, { method: "POST" });
  return richMenuId;
}

async function mfProfileName(userId: string) {
  const r = await mfLine(`/v2/bot/profile/${userId}`);
  return r.ok ? ((await r.json()).displayName as string) : null;
}

async function mfBuildContext() {
  const [users, health, quiz, info] = await Promise.all([
    mfDb.from("mf_users").select("line_user_id,display_name,is_owner,created_at,last_seen").order("last_seen", { ascending: false }).limit(50),
    mfDb.from("mf_health_checks").select("line_user_id,month,total,summary,created_at").order("created_at", { ascending: false }).limit(50),
    mfDb.from("mf_money_quiz").select("line_user_id,dims,persona,created_at").order("created_at", { ascending: false }).limit(50),
    mfDb.from("mf_personal_info").select("line_user_id,data,updated_at").order("updated_at", { ascending: false }).limit(30),
  ]);
  const nameOf: Record<string, string> = {};
  for (const u of users.data || []) nameOf[u.line_user_id] = u.display_name || u.line_user_id.slice(-6);
  const tag = (id: string) => nameOf[id] || id.slice(-6);
  return JSON.stringify({
    統計: {
      用戶數: users.data?.length || 0, 健康檢測次數: health.data?.length || 0,
      財務測驗次數: quiz.data?.length || 0, 已填個人資訊人數: info.data?.length || 0,
    },
    用戶: (users.data || []).map((u) => ({ 名稱: tag(u.line_user_id), 擁有者: u.is_owner, 加入: u.created_at, 最近使用: u.last_seen })),
    健康檢測: (health.data || []).map((h) => ({ 用戶: tag(h.line_user_id), 月份: h.month, 分數: h.total, 總評: h.summary })),
    財務測驗: (quiz.data || []).map((q) => ({ 用戶: tag(q.line_user_id), 性格: q.persona, 五力: q.dims, 時間: q.created_at })),
    個人資訊: (info.data || []).map((p) => ({ 用戶: tag(p.line_user_id), 資料: p.data, 更新: p.updated_at })),
  }).slice(0, 60000);
}

async function mfAskAI(ownerId: string, question: string) {
  const { data: history } = await mfDb.from("mf_chat_logs").select("role,content").eq("line_user_id", ownerId)
    .order("created_at", { ascending: false }).limit(10);
  const context = await mfBuildContext();
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${Deno.env.get("OPENAI_API_KEY")}` },
    body: JSON.stringify({
      model: MF_OPENAI_MODEL,
      temperature: 0.5,
      messages: [
        {
          role: "system",
          content: `你是 MoneyFree LINE 官方帳號擁有者的專屬金融助理。用繁體中文(台灣用語),語氣溫暖、清楚、簡短。
你可以回答金融相關問題,並根據下方資料庫內容回答用戶資料、使用狀況、問答統計與細節。
不做醫療診斷,遇到急症請對方立即就醫;不保證投資報酬。資料中沒有的內容就說不知道,不要編造。
LINE 純文字回覆,不要用 Markdown 語法。
【資料庫(JSON)】
${context}`,
        },
        ...(history || []).reverse().map((h) => ({ role: h.role, content: h.content })),
        { role: "user", content: question },
      ],
    }),
  });
  if (!r.ok) return `AI 暫時無法回應(${r.status}),請確認 OPENAI_API_KEY 額度。`;
  const d = await r.json();
  return (d.choices?.[0]?.message?.content || "我暫時想不到答案,換個方式問問看?").trim();
}

async function mfHandleEvent(ev: Record<string, any>) {
  const userId = ev.source?.userId as string | undefined;
  if (!userId) return;
  await mfDb.from("mf_users").upsert({ line_user_id: userId, last_seen: new Date().toISOString() }, { onConflict: "line_user_id" });
  if (ev.type === "follow") {
    const name = await mfProfileName(userId);
    if (name) await mfDb.from("mf_users").update({ display_name: name }).eq("line_user_id", userId);
    return;
  }
  if (ev.type !== "message" || ev.message?.type !== "text") return;
  const text = String(ev.message.text || "").trim();
  const { data: owner } = await mfDb.from("mf_users").select("line_user_id").eq("is_owner", true).maybeSingle();

  // 尚無擁有者:第一位傳「綁定管理員」的人成為擁有者(之後鎖定)
  if (!owner) {
    if (text !== "綁定管理員") return;
    const name = await mfProfileName(userId);
    await mfDb.from("mf_users").update({ is_owner: true, display_name: name }).eq("line_user_id", userId);
    let menuMsg = "圖文選單已建立。";
    try { await mfSetupRichMenu(); } catch (e) { menuMsg = `圖文選單建立失敗:${(e as Error).message}。網站上線後傳「更新選單」重試。`; }
    await mfReply(ev.replyToken, `已將你設為 MoneyFree 擁有者 ✅\n${menuMsg}\n之後直接傳訊息就能問我金融問題或用戶資料。`);
    return;
  }
  if (owner.line_user_id !== userId) return; // 非擁有者:不回應

  if (text === "更新選單") {
    try { await mfSetupRichMenu(); await mfReply(ev.replyToken, "圖文選單已更新 ✅"); }
    catch (e) { await mfReply(ev.replyToken, `更新失敗:${(e as Error).message}`); }
    return;
  }
  const answer = await mfAskAI(userId, text);
  await mfDb.from("mf_chat_logs").insert([
    { line_user_id: userId, role: "user", content: text.slice(0, 2000) },
    { line_user_id: userId, role: "assistant", content: answer.slice(0, 4000) },
  ]);
  await mfReply(ev.replyToken, answer);
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("MoneyFree webhook OK", { status: 200 });
  const raw = await req.text();
  if (!(await mfVerifySignature(raw, req.headers.get("x-line-signature")))) {
    return new Response("invalid signature", { status: 401 });
  }
  const body = JSON.parse(raw || "{}");
  for (const ev of body.events || []) {
    try { await mfHandleEvent(ev); } catch (e) { console.error("mf-line-webhook event error", e); }
  }
  return new Response("ok", { status: 200 });
});
