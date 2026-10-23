// moneyfree 群發:草稿(照片 + 文字)→ 預覽(含配額估算)→ 確認後發給所有好友
import { mfDb, mfImage, mfLine, MfMessage, mfReply, mfReplyOrPush, mfText } from "./mf_line.ts";

export const MF_MAX_IMAGES = 4;

async function mfFollowerEstimate() {
  const d = new Date(Date.now() + 9 * 3600e3 - 86400e3).toISOString().slice(0, 10).replace(/-/g, "");
  const r = await mfLine(`/v2/bot/insight/followers?date=${d}`);
  if (!r.ok) return null;
  const j = await r.json();
  return j.status === "ready" ? Math.max(0, (j.followers || 0) - (j.blocks || 0)) : null;
}

// purpose:broadcast = 群發草稿;compose = 「修改圖文」的素材照片
export async function mfDraftImages(ownerId: string, purpose = "broadcast") {
  const { data } = await mfDb.from("mf_broadcast_images").select("url,preview_url").eq("owner_id", ownerId)
    .eq("purpose", purpose).order("created_at", { ascending: true }).limit(MF_MAX_IMAGES);
  return data || [];
}

export async function mfClearImages(ownerId: string, purpose: string) {
  await mfDb.from("mf_broadcast_images").delete().eq("owner_id", ownerId).eq("purpose", purpose);
}

export async function mfClearDraft(ownerId: string) {
  await mfClearImages(ownerId, "broadcast");
  await mfDb.from("mf_broadcast_drafts").delete().eq("owner_id", ownerId);
}

// 以單張圖片建立新的群發草稿(覆蓋舊草稿)
export async function mfDraftFromImage(ownerId: string, url: string, preview: string) {
  await mfClearDraft(ownerId);
  await mfDb.from("mf_broadcast_images").insert({ owner_id: ownerId, url, preview_url: preview, purpose: "broadcast" });
  await mfDb.from("mf_broadcast_drafts").upsert({ owner_id: ownerId, text: null, updated_at: new Date().toISOString() });
}

export async function mfPreviewHead(imageCount: number, text: string | null) {
  const friends = await mfFollowerEstimate();
  const perPerson = imageCount + (text ? 1 : 0);
  const quota = friends === null ? `每位好友 ${perPerson} 則` : `約 ${friends} 位好友 × ${perPerson} 則 = ${friends * perPerson} 則`;
  return `【群發預覽】照片 ${imageCount} 張${text ? "\n文字:\n" + text : "(無文字,可輸入「群發 要說的話」加上文字)"}` +
    `\n\n將發給所有好友,預計用掉配額:${quota}\n回覆「確認群發」送出,或「取消群發」放棄。`;
}

// 預覽訊息:說明 + 照片(最多 4 張,合計 5 則)
export async function mfBroadcastPreview(replyToken: string, ownerId: string, text: string | null) {
  const images = await mfDraftImages(ownerId);
  await mfDb.from("mf_broadcast_drafts").upsert({ owner_id: ownerId, text: text || null, updated_at: new Date().toISOString() });
  const head = await mfPreviewHead(images.length, text);
  const messages: MfMessage[] = [mfText(head), ...images.map((i) => mfImage(i.url, i.preview_url))];
  await mfReplyOrPush(replyToken, ownerId, messages);
}

export async function mfBroadcastConfirm(replyToken: string, ownerId: string) {
  const images = await mfDraftImages(ownerId);
  const { data: draft } = await mfDb.from("mf_broadcast_drafts").select("text").eq("owner_id", ownerId).maybeSingle();
  if (!draft) { await mfReply(replyToken, "目前沒有待確認的群發。請先傳照片,再輸入「群發 文字」預覽。"); return; }
  const messages: MfMessage[] = images.map((i) => mfImage(i.url, i.preview_url));
  if (draft.text) messages.push(mfText(draft.text));
  if (!messages.length) { await mfReply(replyToken, "群發內容是空的"); return; }
  const requestId = crypto.randomUUID();
  const r = await mfLine("/v2/bot/message/broadcast", {
    method: "POST", headers: { "X-Line-Retry-Key": requestId }, body: JSON.stringify({ messages }),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    await mfReply(replyToken, `群發失敗(${r.status}):${err.message || ""}\n若是額度不足,請到 OA Manager 確認本月訊息配額。草稿仍保留。`);
    return;
  }
  await mfDb.from("mf_broadcast_logs").insert({ owner_id: ownerId, images, text: draft.text, request_id: requestId });
  await mfClearDraft(ownerId);
  await mfReply(replyToken, `已群發給所有好友 ✅(照片 ${images.length} 張${draft.text ? " + 文字" : ""})`);
}
