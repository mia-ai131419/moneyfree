// moneyfree「圖文」流程:先問「群發 / 修改圖文」→ 產生圖文進群發預覽,或用 1–4 張照片整合成一張專業圖文
import { mfDb, mfLine, MfMessage, mfReply, mfReplyMessages, mfShowLoading } from "./mf_line.ts";
import { mfGenerateAndSend, mfLogImage, mfStamp, mfStoreForLine } from "./mf_image_gen.ts";
import { mfPlanImage } from "./mf_image_prompt.ts";
import {
  MF_MAX_IMAGES, mfBroadcastPreview, mfClearImages, mfDraftFromImage, mfDraftImages, mfPreviewHead,
} from "./mf_broadcast.ts";

const MF_STATE_TTL_MS = 30 * 60 * 1000;
const MF_COMPOSE_DEFAULT = "整合照片,展現個人金融專業形象";
export const MF_CHOICE_BROADCAST = "選擇群發";
export const MF_CHOICE_COMPOSE = "選擇修改圖文";
export const MF_COMPOSE_DONE = "完成";
export const MF_BROADCAST_LAST = "群發這張";

// 文字訊息 + 快速選項按鈕
function mfChoices(text: string, options: [string, string][]): MfMessage {
  return {
    type: "text", text,
    quickReply: { items: options.map(([label, t]) => ({ type: "action", action: { type: "message", label, text: t } })) },
  };
}

export async function mfGetState(ownerId: string) {
  const { data } = await mfDb.from("mf_owner_state").select("mode,request,updated_at").eq("owner_id", ownerId).maybeSingle();
  if (!data || Date.now() - new Date(data.updated_at).getTime() > MF_STATE_TTL_MS) return null;
  return data as { mode: string; request: string | null };
}

async function mfSetState(ownerId: string, mode: string, request: string | null) {
  await mfDb.from("mf_owner_state").upsert({ owner_id: ownerId, mode, request, updated_at: new Date().toISOString() });
}

export async function mfClearState(ownerId: string) {
  await mfDb.from("mf_owner_state").delete().eq("owner_id", ownerId);
}

// 1. 「圖文 需求」→ 詢問用途
export async function mfAskImageChoice(token: string, ownerId: string, request: string) {
  await mfSetState(ownerId, "await_choice", request || null);
  await mfReplyMessages(token, [mfChoices(
    `收到圖文需求${request ? `:「${request.slice(0, 60)}」` : ""}\n請選擇:\n・群發:產生圖文後進入群發預覽\n・修改圖文:上傳 1–4 張照片,整合成一張專業圖文`,
    [["群發", MF_CHOICE_BROADCAST], ["修改圖文", MF_CHOICE_COMPOSE]],
  )]);
}

// 2a. 群發:產生圖文 → 建立群發草稿 → 圖片 + 預覽一起回覆
export async function mfChooseBroadcast(token: string, ownerId: string, request: string | null) {
  if (!request) { await mfReply(token, "群發需要圖文內容,請輸入「圖文 需求」,例如:圖文 年底理財講座開放報名"); return; }
  await mfClearState(ownerId);
  await mfShowLoading(ownerId);
  const plan = await mfPlanImage(request);
  if (!plan.ok) { await mfReply(token, `無法產生圖片:${plan.reason}`); return; }
  const head = await mfPreviewHead(1, null);
  const caption = `${plan.notice ? `⚠️ 提醒:${plan.notice}\n\n` : ""}${head}\n(要調整圖片請輸入「圖片修改 需求」,再輸入「群發這張」)`;
  const img = await mfGenerateAndSend(token, ownerId, plan.prompt, "gen", caption);
  if (!img) return;
  await mfLogImage(ownerId, img, request);
  await mfDraftFromImage(ownerId, img.url, img.preview);
}

// 2b. 修改圖文:開始收照片
export async function mfChooseCompose(token: string, ownerId: string, request: string | null) {
  await mfClearImages(ownerId, "compose");
  await mfSetState(ownerId, "collect_photos", request);
  await mfReply(token, `請傳 1–${MF_MAX_IMAGES} 張照片(個人照、活動照、商品照都可以),傳完輸入「完成」開始整合。\n輸入「取消」可放棄。`);
}

// 收到素材照片
export async function mfComposeImage(ev: Record<string, any>, ownerId: string, request: string | null) {
  const have = (await mfDraftImages(ownerId, "compose")).length;
  if (have >= MF_MAX_IMAGES) {
    await mfReplyMessages(ev.replyToken, [mfChoices(`最多 ${MF_MAX_IMAGES} 張,這張沒有加入。`, [["完成", MF_COMPOSE_DONE]])]);
    return;
  }
  const r = await mfLine(`/v2/bot/message/${ev.message.id}/content`, {}, "api-data.line.me");
  if (!r.ok) { await mfReply(ev.replyToken, "照片下載失敗,請重傳一次"); return; }
  const { url, preview } = await mfStoreForLine(`compose/${mfStamp()}`, new Uint8Array(await r.arrayBuffer()), r.headers.get("content-type") || "image/jpeg");
  await mfDb.from("mf_broadcast_images").insert({ owner_id: ownerId, url, preview_url: preview, purpose: "compose" });
  await mfSetState(ownerId, "collect_photos", request); // 延長有效時間
  await mfReplyMessages(ev.replyToken, [mfChoices(
    `已收到第 ${have + 1} 張(最多 ${MF_MAX_IMAGES} 張)。繼續傳,或按「完成」開始整合。`, [["完成", MF_COMPOSE_DONE]],
  )]);
}

// 3. 完成:整合照片成一張圖文
export async function mfComposeDone(token: string, ownerId: string, request: string | null) {
  const photos = await mfDraftImages(ownerId, "compose");
  if (!photos.length) { await mfReply(token, "還沒有收到照片,請先傳 1–4 張照片再按「完成」。"); return; }
  await mfShowLoading(ownerId);
  const plan = await mfPlanImage(request || MF_COMPOSE_DEFAULT);
  if (!plan.ok) { await mfReply(token, `無法產生圖片:${plan.reason}`); return; }
  const sources: Uint8Array[] = [];
  for (const p of photos) {
    const r = await fetch(p.url);
    if (r.ok) sources.push(new Uint8Array(await r.arrayBuffer()));
  }
  const prompt = `Combine the ${sources.length} reference photo(s) into ONE cohesive, polished square social media image for a financial advisor brand.
Keep any people's faces and identity faithful to the photos; you may rearrange, crop, retouch and blend them.
The image must convey personal professionalism, trustworthiness, financial protection and security (e.g. calm confident posture, shield or umbrella motifs, stable architecture, warm light).
Brand palette: silver, gold, light blue. Elegant, premium, clean layout.
${plan.prompt}`;
  const extra = [mfChoices("下一步?", [["群發這張", MF_BROADCAST_LAST], ["圖片修改", "圖片修改"]])];
  const caption = `圖文整合完成 ✅${plan.title ? `\n標題:${plan.title}` : ""}${plan.notice ? `\n\n⚠️ 提醒:${plan.notice}` : ""}` +
    `\n\n要調整請輸入「圖片修改 需求」\n長按可儲存或轉傳`;
  const img = await mfGenerateAndSend(token, ownerId, prompt, "gen", caption, sources, extra);
  if (!img) return;
  await mfLogImage(ownerId, img, `整合:${request || MF_COMPOSE_DEFAULT}`);
  await mfClearImages(ownerId, "compose");
  await mfClearState(ownerId);
}

// 把最近一張圖文放進群發草稿並預覽
export async function mfBroadcastLast(token: string, ownerId: string) {
  const { data: last } = await mfDb.from("mf_image_logs").select("url,preview_url").eq("owner_id", ownerId)
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (!last) { await mfReply(token, "還沒有可群發的圖文,請先輸入「圖文 需求」。"); return; }
  await mfDraftFromImage(ownerId, last.url, last.preview_url || last.url);
  await mfBroadcastPreview(token, ownerId, null);
}

// 擁有者文字訊息若屬於圖文流程就處理並回傳 true
export async function mfComposeText(token: string, ownerId: string, text: string) {
  if (text === MF_BROADCAST_LAST) { await mfBroadcastLast(token, ownerId); return true; }
  const state = await mfGetState(ownerId);
  if (!state) return false;
  if (text === "取消") {
    await mfClearImages(ownerId, "compose"); await mfClearState(ownerId);
    await mfReply(token, "已取消圖文流程"); return true;
  }
  if (state.mode === "await_choice" && text === MF_CHOICE_BROADCAST) { await mfChooseBroadcast(token, ownerId, state.request); return true; }
  if (state.mode === "await_choice" && text === MF_CHOICE_COMPOSE) { await mfChooseCompose(token, ownerId, state.request); return true; }
  if (state.mode === "collect_photos" && text === MF_COMPOSE_DONE) { await mfComposeDone(token, ownerId, state.request); return true; }
  return false;
}

