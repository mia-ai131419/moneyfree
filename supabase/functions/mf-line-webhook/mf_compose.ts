// moneyfree「圖文」卡片流程:
// 圖文 → [製作群發圖片 / 修改圖片]
//   製作群發圖片 → [輸入文字產生 / 上傳照片整合] → 產生 → [確認群發 / 修改這張 / 重新產生 / 取消]
//   修改圖片 → 輸入修改內容 → [確認群發 / 再修改 / 結束]
import { mfDb, mfLine, MfMessage, mfReply, mfReplyMessages, mfShowLoading } from "./mf_line.ts";
import { mfGenerateAndSend, mfLogImage, mfStamp, mfStoreForLine } from "./mf_image_gen.ts";
import { mfPlanImage } from "./mf_image_prompt.ts";
import { MF_MAX_IMAGES, mfBroadcastConfirm, mfBroadcastPreview, mfClearDraft, mfClearImages, mfDraftFromImage, mfDraftImages, mfPreviewHead } from "./mf_broadcast.ts";
import { MfButton, mfCard } from "./mf_cards.ts";

const MF_STATE_TTL_MS = 30 * 60 * 1000;
const MF_COMPOSE_DEFAULT = "整合照片,展現個人金融專業形象";
const B = {
  make: "製作群發圖片", edit: "修改圖片", text: "輸入文字產生", photo: "上傳照片整合", done: "完成",
  confirm: "確認群發", editThis: "修改這張", regen: "重新產生", cancel: "取消", finish: "結束", last: "群發這張",
};
// 等待使用者輸入內容時,這些開頭仍視為指令而不是內容
const MF_COMMAND_PREFIXES = ["指令", "說明", "群發", "確認群發", "取消群發", "財務表格", "設計", "更新選單", "圖文"];
const CANCEL: MfButton = ["取消", B.cancel, false];

type MfState = { mode: string; request: string | null };

async function mfGetState(ownerId: string): Promise<MfState | null> {
  const { data } = await mfDb.from("mf_owner_state").select("mode,request,updated_at").eq("owner_id", ownerId).maybeSingle();
  if (!data || Date.now() - new Date(data.updated_at).getTime() > MF_STATE_TTL_MS) return null;
  return data;
}
export { mfGetState };

async function mfSetState(ownerId: string, mode: string, request: string | null) {
  await mfDb.from("mf_owner_state").upsert({ owner_id: ownerId, mode, request, updated_at: new Date().toISOString() });
}

async function mfClearState(ownerId: string) {
  await mfDb.from("mf_owner_state").delete().eq("owner_id", ownerId);
}

function mfCardReply(token: string, title: string, body: string, buttons: MfButton[]) {
  return mfReplyMessages(token, [mfCard(title, body, buttons)]);
}

// ── 主選單 ──
async function mfImageMenu(token: string, ownerId: string, request: string | null) {
  await mfSetState(ownerId, "menu", request);
  await mfCardReply(token, "圖文工具", request ? `需求:${request.slice(0, 80)}\n請選擇要做什麼` : "請選擇要做什麼",
    [["製作群發圖片", B.make], ["修改圖片", B.edit], CANCEL]);
}

async function mfMakeMenu(token: string, ownerId: string, request: string | null) {
  await mfSetState(ownerId, "menu", request);
  await mfCardReply(token, "製作群發圖片", "要用什麼方式製作?\n・輸入文字產生:描述你要的圖片(可貼網址)\n・上傳照片整合:1–4 張照片整合成專業圖文",
    [["輸入文字產生", B.text], ["上傳照片整合", B.photo], CANCEL]);
}

// ── 產生結果卡 ──
async function mfResultExtra(isEdit: boolean, notice: string) {
  const head = await mfPreviewHead(1, null);
  const body = `${notice ? `⚠️ 提醒:${notice}\n\n` : ""}${head.replace(/\n回覆.*$/s, "")}`;
  return isEdit
    ? [mfCard("圖片修改完成", body, [["確認群發", B.confirm], ["再修改", B.editThis, false], ["結束", B.finish, false]])]
    : [mfCard("圖片完成", body, [["確認群發", B.confirm], ["修改這張", B.editThis, false], ["重新產生", B.regen, false], CANCEL])];
}

async function mfGenerateForBroadcast(token: string, ownerId: string, request: string) {
  await mfShowLoading(ownerId);
  const plan = await mfPlanImage(request);
  if (!plan.ok) { await mfReply(token, `無法產生圖片:${plan.reason}`); return; }
  const caption = `標題:${plan.title || "(無)"}${plan.source ? `\n來源:${plan.source}` : ""}\n長按圖片可儲存或轉傳`;
  const img = await mfGenerateAndSend(token, ownerId, plan.prompt, "gen", caption, undefined, await mfResultExtra(false, plan.notice));
  if (!img) return;
  await mfLogImage(ownerId, img, request);
  await mfDraftFromImage(ownerId, img.url, img.preview);
  await mfSetState(ownerId, "result", request);
}

async function mfComposePhotos(token: string, ownerId: string, request: string | null) {
  const photos = await mfDraftImages(ownerId, "compose");
  if (!photos.length) { await mfCardReply(token, "還沒有照片", "請先傳 1–4 張照片,再按「完成」。", [["完成", B.done], CANCEL]); return; }
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
  const caption = `照片整合完成${plan.title ? `\n標題:${plan.title}` : ""}\n長按圖片可儲存或轉傳`;
  const img = await mfGenerateAndSend(token, ownerId, prompt, "gen", caption, sources, await mfResultExtra(false, plan.notice));
  if (!img) return;
  await mfLogImage(ownerId, img, `整合:${request || MF_COMPOSE_DEFAULT}`);
  await mfDraftFromImage(ownerId, img.url, img.preview);
  await mfClearImages(ownerId, "compose");
  await mfSetState(ownerId, "result", request || MF_COMPOSE_DEFAULT);
}

// 修改最近一張圖(並更新群發草稿)
export async function mfEditLast(token: string, ownerId: string, request: string) {
  const { data: last } = await mfDb.from("mf_image_logs").select("url").eq("owner_id", ownerId)
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (!last) { await mfCardReply(token, "沒有可修改的圖片", "請先製作一張圖片。", [["製作群發圖片", B.make]]); return; }
  await mfShowLoading(ownerId);
  const src = await fetch(last.url);
  if (!src.ok) { await mfReply(token, "找不到上一張圖片,請重新產生。"); return; }
  const prompt = `Edit this image according to the request below. Keep the overall layout, style and anything not mentioned unchanged. ` +
    `Any Chinese text must be correct, clear Traditional Chinese; do not add extra small text.\nRequest: ${request}`;
  const img = await mfGenerateAndSend(token, ownerId, prompt, "gen", `已依「${request.slice(0, 40)}」修改\n長按圖片可儲存或轉傳`,
    [new Uint8Array(await src.arrayBuffer())], await mfResultExtra(true, ""));
  if (!img) return;
  await mfLogImage(ownerId, img, `修改:${request}`);
  await mfDraftFromImage(ownerId, img.url, img.preview);
  await mfSetState(ownerId, "result", request);
}

async function mfAskEdit(token: string, ownerId: string) {
  const { data: last } = await mfDb.from("mf_image_logs").select("id").eq("owner_id", ownerId).limit(1).maybeSingle();
  if (!last) { await mfCardReply(token, "沒有可修改的圖片", "請先製作一張圖片。", [["製作群發圖片", B.make], CANCEL]); return; }
  await mfSetState(ownerId, "await_edit", null);
  await mfCardReply(token, "修改圖片", "請直接輸入要修改的地方,例如:\n背景換成夜景、標題改成「理財講座」", [CANCEL]);
}

// 收到素材照片
export async function mfComposeImage(ev: Record<string, any>, ownerId: string, request: string | null) {
  const have = (await mfDraftImages(ownerId, "compose")).length;
  if (have >= MF_MAX_IMAGES) {
    await mfCardReply(ev.replyToken, "照片已達上限", `最多 ${MF_MAX_IMAGES} 張,這張沒有加入。`, [["完成", B.done], CANCEL]);
    return;
  }
  const r = await mfLine(`/v2/bot/message/${ev.message.id}/content`, {}, "api-data.line.me");
  if (!r.ok) { await mfReply(ev.replyToken, "照片下載失敗,請重傳一次"); return; }
  const { url, preview } = await mfStoreForLine(`compose/${mfStamp()}`, new Uint8Array(await r.arrayBuffer()), r.headers.get("content-type") || "image/jpeg");
  await mfDb.from("mf_broadcast_images").insert({ owner_id: ownerId, url, preview_url: preview, purpose: "compose" });
  await mfSetState(ownerId, "collect_photos", request); // 延長有效時間
  await mfCardReply(ev.replyToken, `已收到第 ${have + 1} 張`, `最多 ${MF_MAX_IMAGES} 張。可以繼續傳,或按「完成」開始整合。`, [["完成", B.done], CANCEL]);
}

// 擁有者文字訊息若屬於圖文流程就處理並回傳 true
export async function mfComposeText(token: string, ownerId: string, text: string): Promise<boolean> {
  const isUrlOnly = /^https?:\/\/\S+$/i.test(text);
  if (text.startsWith("圖文") || isUrlOnly) { await mfImageMenu(token, ownerId, (isUrlOnly ? text : text.slice(2).trim()) || null); return true; }
  if (text === B.edit) { await mfAskEdit(token, ownerId); return true; }
  if (/^(圖片修改|修改圖片)\s*\S/.test(text)) { await mfEditLast(token, ownerId, text.slice(4).trim()); return true; }
  if (text === B.last) {
    const { data: last } = await mfDb.from("mf_image_logs").select("url,preview_url").eq("owner_id", ownerId)
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (!last) { await mfReply(token, "還沒有可群發的圖文"); return true; }
    await mfDraftFromImage(ownerId, last.url, last.preview_url || last.url);
    await mfBroadcastPreview(token, ownerId, null);
    return true;
  }

  const state = await mfGetState(ownerId);
  if (!state) return false;
  if (text === B.cancel) {
    await mfClearImages(ownerId, "compose");
    if (state.mode === "result") await mfClearDraft(ownerId);
    await mfClearState(ownerId);
    await mfReply(token, "已取消");
    return true;
  }
  if (text === B.finish) { await mfClearState(ownerId); await mfReply(token, "好的!群發草稿已保留,之後輸入「確認群發」即可送出。"); return true; }
  if (text === B.make) { await mfMakeMenu(token, ownerId, state.request); return true; }
  if (text === B.text) {
    if (state.request) { await mfGenerateForBroadcast(token, ownerId, state.request); return true; }
    await mfSetState(ownerId, "await_text", null);
    await mfCardReply(token, "輸入圖片內容", "請直接輸入圖片要呈現的內容,也可以貼網址,例如:\n年底理財講座開放報名", [CANCEL]);
    return true;
  }
  if (text === B.photo) {
    await mfClearImages(ownerId, "compose");
    await mfSetState(ownerId, "collect_photos", state.request);
    await mfCardReply(token, "上傳照片", `請傳 1–${MF_MAX_IMAGES} 張照片(個人照、活動照、商品照都可以),傳完按「完成」。`, [["完成", B.done], CANCEL]);
    return true;
  }
  if (text === B.done && state.mode === "collect_photos") { await mfComposePhotos(token, ownerId, state.request); return true; }
  if (text === B.editThis) { await mfAskEdit(token, ownerId); return true; }
  if (text === B.regen && state.request) { await mfGenerateForBroadcast(token, ownerId, state.request); return true; }
  if (text === B.confirm && state.mode === "result") { await mfClearState(ownerId); await mfBroadcastConfirm(token, ownerId); return true; }

  // 等待輸入內容中:把這段文字當成需求
  const isCommand = MF_COMMAND_PREFIXES.some((p) => text.startsWith(p));
  if (!isCommand && state.mode === "await_text") { await mfGenerateForBroadcast(token, ownerId, text); return true; }
  if (!isCommand && state.mode === "await_edit") { await mfEditLast(token, ownerId, text); return true; }
  return false;
}
