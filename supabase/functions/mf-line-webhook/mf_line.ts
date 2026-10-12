// moneyfree 共用:Supabase 連線與 LINE Messaging API 呼叫
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

export const MF_SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
export const mfDb = createClient(MF_SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const mfToken = Deno.env.get("LINE_TOKEN") || "";

export type MfMessage = Record<string, unknown>;

export function mfLine(path: string, init: RequestInit = {}, host = "api.line.me") {
  return fetch(`https://${host}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${mfToken}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
}

export function mfText(text: string): MfMessage {
  return { type: "text", text: text.slice(0, 4900) };
}

export function mfImage(url: string, previewUrl: string): MfMessage {
  return { type: "image", originalContentUrl: url, previewImageUrl: previewUrl };
}

export async function mfReply(replyToken: string, text: string) {
  await mfReplyMessages(replyToken, [mfText(text)]);
}

export async function mfReplyMessages(replyToken: string, messages: MfMessage[]) {
  const r = await mfLine("/v2/bot/message/reply", {
    method: "POST", body: JSON.stringify({ replyToken, messages: messages.slice(0, 5) }),
  });
  return r.ok;
}

// 先用 reply(免費);reply token 過期時改用 push(會計入訊息配額)
export async function mfReplyOrPush(replyToken: string, userId: string, messages: MfMessage[]) {
  if (await mfReplyMessages(replyToken, messages)) return;
  await mfLine("/v2/bot/message/push", {
    method: "POST", body: JSON.stringify({ to: userId, messages: messages.slice(0, 5) }),
  });
}

export async function mfShowLoading(userId: string, seconds = 60) {
  await mfLine("/v2/bot/chat/loading/start", {
    method: "POST", body: JSON.stringify({ chatId: userId, loadingSeconds: seconds }),
  }).catch(() => {});
}

export async function mfUploadImage(path: string, bytes: Uint8Array, contentType: string) {
  const { error } = await mfDb.storage.from("mf_images").upload(path, bytes, { contentType, upsert: true });
  if (error) throw new Error(`圖片儲存失敗:${error.message}`);
  return `${MF_SUPABASE_URL}/storage/v1/object/public/mf_images/${path}`;
}
