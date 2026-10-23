// moneyfree 擁有者專用工具:「圖文」生圖、照片群發、「設計模板」
import {
  mfDb, mfImage, mfLine, MfMessage, mfReply, mfReplyMessages, mfReplyOrPush, mfShowLoading, mfText, mfUploadImage,
} from "./mf_line.ts";
import { mfPlanImage } from "./mf_image_prompt.ts";

const MF_OPENAI_KEY = Deno.env.get("OPENAI_API_KEY") || "";
const MF_MAX_BROADCAST_IMAGES = 4;
const MF_IMAGE_MODEL = Deno.env.get("MF_IMAGE_MODEL") || "gpt-image-1"; // 可在 Supabase Secrets 切換新模型
export const MF_HELP_TEXT = `【擁有者指令】
・直接輸入問題:AI 金融助理
・圖文 需求:AI 生成正方形圖片
・直接貼網址(或 圖文 網址 需求):讀取網頁內容後生成圖片
・圖片修改 需求:修改上一張產生的圖片
・傳照片:暫存要群發的照片(最多 4 張)
・群發 文字:預覽群發內容(要以「群發」開頭)
・確認群發 / 取消群發
・設計 需求(可省略):AI 產生介面配色模板
・更新選單:重新上傳圖文選單`;

function mfStamp() {
  return `${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
}

// 存到 Storage;超過 1MB 另做縮圖給 LINE 的 previewImageUrl
async function mfStoreForLine(prefix: string, bytes: Uint8Array, contentType: string) {
  const ext = contentType.includes("png") ? "png" : "jpg";
  const url = await mfUploadImage(`${prefix}.${ext}`, bytes, contentType);
  if (bytes.length <= 1_000_000) return { url, preview: url };
  const { Image } = await import("npm:imagescript@1.3.0");
  const img = await Image.decode(bytes);
  img.resize(480, Image.RESIZE_AUTO);
  const preview = await mfUploadImage(`${prefix}_p.jpg`, await img.encodeJPEG(80), "image/jpeg");
  return { url, preview };
}

// 修改既有圖片:OpenAI images/edits(multipart)
async function mfOpenAIEdit(prompt: string, source: Uint8Array) {
  const form = new FormData();
  form.append("model", MF_IMAGE_MODEL);
  form.append("prompt", prompt);
  const isPng = source[0] === 0x89 && source[1] === 0x50; // PNG 檔頭
  form.append("image", new Blob([source], { type: isPng ? "image/png" : "image/jpeg" }), isPng ? "source.png" : "source.jpg");
  form.append("size", "1024x1024");
  form.append("quality", "high");
  form.append("output_format", "jpeg");
  const r = await fetch("https://api.openai.com/v1/images/edits", {
    method: "POST", headers: { Authorization: `Bearer ${MF_OPENAI_KEY}` }, body: form,
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d?.error?.message || `OpenAI 錯誤(${r.status})`);
  const b64 = d?.data?.[0]?.b64_json;
  if (!b64) throw new Error("沒有取得圖片");
  return { bytes: Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)), contentType: "image/jpeg" };
}

async function mfOpenAIImage(prompt: string, editSource?: Uint8Array) {
  if (editSource) return await mfOpenAIEdit(prompt, editSource);
  const call = (body: Record<string, unknown>) => fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${MF_OPENAI_KEY}` },
    body: JSON.stringify(body),
  });
  let r = await call({
    model: MF_IMAGE_MODEL, prompt, size: "1024x1024", quality: "high", output_format: "jpeg", output_compression: 85,
  });
  let contentType = "image/jpeg";
  if (!r.ok && [400, 403, 404].includes(r.status)) {
    // 帳號未開通 gpt-image-1 時改用 dall-e-3
    r = await call({ model: "dall-e-3", prompt, size: "1024x1024", quality: "hd", response_format: "b64_json" });
    contentType = "image/png";
  }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d?.error?.message || `OpenAI 錯誤(${r.status})`);
  const b64 = d?.data?.[0]?.b64_json;
  if (!b64) throw new Error("沒有取得圖片");
  return { bytes: Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)), contentType };
}

async function mfGenerateAndSend(
  replyToken: string, userId: string, prompt: string, prefix: string, caption: string, editSource?: Uint8Array,
) {
  try {
    const { bytes, contentType } = await mfOpenAIImage(prompt, editSource);
    const { url, preview } = await mfStoreForLine(`${prefix}/${mfStamp()}`, bytes, contentType);
    await mfReplyOrPush(replyToken, userId, [mfImage(url, preview), mfText(caption)]);
    return url;
  } catch (e) {
    await mfReplyOrPush(replyToken, userId, [mfText(`圖片生成失敗:${(e as Error).message}`)]);
    return null;
  }
}

async function mfDesignTemplate(replyToken: string, userId: string, request: string) {
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${MF_OPENAI_KEY}` },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [{
        role: "system",
        content: `你是資深 UI 設計師,為金融服務 LINE 官方帳號「MoneyFree」設計手機網頁與圖文選單模板。
固定規則:底色銀色 #BCC6CC、主色金色系、配色藍色 #CCDDFF;文字需清楚可讀(對比足夠)。
頁面:健康大數據檢測(拍照)、財務健康度檢測(心理測驗+雷達圖)、個人資訊填寫(表單);圖文選單 2x2 四格。
用繁體中文,只輸出 JSON:{"name":"模板名稱","concept":"40字內設計理念",
"colors":{"background":"#BCC6CC","primary":"金色hex","primary_dark":"hex","accent":"#CCDDFF","text":"hex","card":"hex"},
"typography":"字體與字級建議","header":"標題區樣式","card":"卡片樣式","button_primary":"主按鈕樣式","button_secondary":"次按鈕樣式",
"rich_menu":"圖文選單版面、圖示與文字樣式","image_prompt":"給生圖模型的英文提示詞:一張 iPhone 手機 UI 設計稿,左側為頁面、右側為 2x2 圖文選單,套用以上配色,高質感金融風格"}`,
      }, { role: "user", content: request || "請提出一個更有質感、更精緻的版本" }],
    }),
  });
  if (!r.ok) { await mfReplyOrPush(replyToken, userId, [mfText(`設計模板產生失敗(${r.status})`)]); return; }
  const spec = JSON.parse((await r.json()).choices?.[0]?.message?.content || "{}");
  const c = spec.colors || {};
  const summary = `【設計模板:${spec.name || "未命名"}】\n${spec.concept || ""}\n\n配色:底 ${c.background} / 主 ${c.primary}(深 ${c.primary_dark}) / 配 ${c.accent} / 字 ${c.text}\n標題區:${spec.header}\n卡片:${spec.card}\n主按鈕:${spec.button_primary}\n次按鈕:${spec.button_secondary}\n圖文選單:${spec.rich_menu}\n\n示意圖文字可能不精確,以上方規格為準。確認後請通知工程師套用。`;
  const url = await mfGenerateAndSend(replyToken, userId, String(spec.image_prompt || "luxury fintech mobile UI mockup, silver background, gold primary, light blue accent"), "design", summary);
  await mfDb.from("mf_design_drafts").insert({ request: request || null, spec, mockup_url: url });
}

async function mfFollowerEstimate() {
  const d = new Date(Date.now() + 9 * 3600e3 - 86400e3).toISOString().slice(0, 10).replace(/-/g, "");
  const r = await mfLine(`/v2/bot/insight/followers?date=${d}`);
  if (!r.ok) return null;
  const j = await r.json();
  return j.status === "ready" ? Math.max(0, (j.followers || 0) - (j.blocks || 0)) : null;
}

async function mfDraftImages(ownerId: string) {
  const { data } = await mfDb.from("mf_broadcast_images").select("url,preview_url").eq("owner_id", ownerId)
    .order("created_at", { ascending: true }).limit(MF_MAX_BROADCAST_IMAGES);
  return data || [];
}

async function mfClearDraft(ownerId: string) {
  await mfDb.from("mf_broadcast_images").delete().eq("owner_id", ownerId);
  await mfDb.from("mf_broadcast_drafts").delete().eq("owner_id", ownerId);
}

export async function mfOwnerImage(ev: Record<string, any>, ownerId: string) {
  const { count } = await mfDb.from("mf_broadcast_images").select("id", { count: "exact", head: true }).eq("owner_id", ownerId);
  if ((count || 0) >= MF_MAX_BROADCAST_IMAGES) {
    await mfReply(ev.replyToken, `群發最多 ${MF_MAX_BROADCAST_IMAGES} 張照片,這張沒有加入。輸入「取消群發」可重來。`);
    return;
  }
  const r = await mfLine(`/v2/bot/message/${ev.message.id}/content`, {}, "api-data.line.me");
  if (!r.ok) { await mfReply(ev.replyToken, "照片下載失敗,請重傳一次"); return; }
  const contentType = r.headers.get("content-type") || "image/jpeg";
  const { url, preview } = await mfStoreForLine(`broadcast/${mfStamp()}`, new Uint8Array(await r.arrayBuffer()), contentType);
  await mfDb.from("mf_broadcast_images").insert({ owner_id: ownerId, url, preview_url: preview });
  await mfReply(ev.replyToken, `已暫存第 ${(count || 0) + 1} 張照片(最多 ${MF_MAX_BROADCAST_IMAGES} 張)。\n輸入「群發 要說的話」預覽,或「取消群發」放棄。`);
}

// 回傳 Promise 表示已處理(長任務由呼叫端放到背景執行);回傳 null 表示不是擁有者指令
export function mfOwnerCommand(ev: Record<string, any>, ownerId: string, text: string): Promise<unknown> | null {
  const token = ev.replyToken as string;
  if (text === "指令" || text === "說明") return mfReply(token, MF_HELP_TEXT);

  const isUrlOnly = /^https?:\/\/\S+$/i.test(text); // 只貼網址也視為「圖文」
  if (text.startsWith("圖文") || isUrlOnly) {
    const request = isUrlOnly ? text : text.slice(2).trim();
    if (!request) return mfReply(token, "請在「圖文」後面加上需求或網址,例如:\n圖文 金色質感的理財講座海報\n圖文 https://example.com 做成活動宣傳圖");
    return (async () => {
      await mfShowLoading(ownerId);
      const plan = await mfPlanImage(request);
      if (!plan.ok) { await mfReplyOrPush(token, ownerId, [mfText(`無法產生圖片:${plan.reason}`)]); return; }
      const caption = `圖片完成 ✅${plan.title ? `\n標題:${plan.title}` : ""}${plan.source ? `\n來源:${plan.source}` : ""}` +
        `${plan.notice ? `\n\n⚠️ 提醒:${plan.notice}` : ""}\n\n要調整請輸入「圖片修改 需求」\n長按可儲存或轉傳`;
      const url = await mfGenerateAndSend(token, ownerId, plan.prompt, "gen", caption);
      if (url) await mfDb.from("mf_image_logs").insert({ owner_id: ownerId, url, request });
    })();
  }

  if (text.startsWith("圖片修改") || text.startsWith("修改圖片")) {
    const request = text.slice(4).trim();
    if (!request) return mfReply(token, "請在「圖片修改」後面寫要改什麼,例如:圖片修改 背景換成夜景、標題改成「理財講座」");
    return (async () => {
      const { data: last } = await mfDb.from("mf_image_logs").select("url").eq("owner_id", ownerId)
        .order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (!last) { await mfReply(token, "還沒有可以修改的圖片,請先用「圖文 需求」產生一張。"); return; }
      await mfShowLoading(ownerId);
      const src = await fetch(last.url);
      if (!src.ok) { await mfReplyOrPush(token, ownerId, [mfText("找不到上一張圖片,請重新產生。")]); return; }
      const prompt = `Edit this image according to the request below. Keep the overall layout, style and anything not mentioned unchanged. ` +
        `Any Chinese text must be correct, clear Traditional Chinese; do not add extra small text.\nRequest: ${request}`;
      const caption = "圖片修改完成 ✅\n可以繼續輸入「圖片修改 需求」再調整\n長按可儲存或轉傳";
      const url = await mfGenerateAndSend(token, ownerId, prompt, "gen", caption, new Uint8Array(await src.arrayBuffer()));
      if (url) await mfDb.from("mf_image_logs").insert({ owner_id: ownerId, url, request: `修改:${request}` });
    })();
  }

  if (text.startsWith("設計")) {
    return (async () => {
      await mfShowLoading(ownerId);
      await mfDesignTemplate(token, ownerId, text.replace(/^設計(模板)?/, "").trim());
    })();
  }

  if (text === "取消群發") return mfClearDraft(ownerId).then(() => mfReply(token, "已清除群發草稿"));

  if (text === "確認群發") {
    return (async () => {
      const images = await mfDraftImages(ownerId);
      const { data: draft } = await mfDb.from("mf_broadcast_drafts").select("text").eq("owner_id", ownerId).maybeSingle();
      if (!draft) { await mfReply(token, "目前沒有待確認的群發。請先傳照片,再輸入「群發 文字」預覽。"); return; }
      const messages: MfMessage[] = images.map((i) => mfImage(i.url, i.preview_url));
      if (draft.text) messages.push(mfText(draft.text));
      if (!messages.length) { await mfReply(token, "群發內容是空的"); return; }
      const requestId = crypto.randomUUID();
      const r = await mfLine("/v2/bot/message/broadcast", {
        method: "POST", headers: { "X-Line-Retry-Key": requestId }, body: JSON.stringify({ messages }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        await mfReply(token, `群發失敗(${r.status}):${err.message || ""}\n若是額度不足,請到 OA Manager 確認本月訊息配額。草稿仍保留。`);
        return;
      }
      await mfDb.from("mf_broadcast_logs").insert({ owner_id: ownerId, images, text: draft.text, request_id: requestId });
      await mfClearDraft(ownerId);
      await mfReply(token, `已群發給所有好友 ✅(照片 ${images.length} 張${draft.text ? " + 文字" : ""})`);
    })();
  }

  if (text.startsWith("群發")) {
    return (async () => {
      const body = text.slice(2).trim();
      const images = await mfDraftImages(ownerId);
      if (!images.length && !body) { await mfReply(token, "請先傳要群發的照片,或輸入「群發 要說的話」"); return; }
      await mfDb.from("mf_broadcast_drafts").upsert({ owner_id: ownerId, text: body || null, updated_at: new Date().toISOString() });
      const friends = await mfFollowerEstimate();
      const perPerson = images.length + (body ? 1 : 0);
      const quota = friends === null ? `每位好友 ${perPerson} 則` : `約 ${friends} 位好友 × ${perPerson} 則 = ${friends * perPerson} 則`;
      const head = `【群發預覽】照片 ${images.length} 張${body ? "\n文字:\n" + body : "(無文字)"}\n\n將發給所有好友,預計用掉配額:${quota}\n回覆「確認群發」送出,或「取消群發」放棄。`;
      await mfReplyMessages(token, [mfText(head), ...images.map((i) => mfImage(i.url, i.preview_url))]);
    })();
  }
  return null;
}
