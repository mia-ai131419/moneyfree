// moneyfree 生圖共用:OpenAI 產生/修改圖片、存到 Storage、回傳給 LINE
import { mfDb, mfImage, MfMessage, mfReplyOrPush, mfText, mfUploadImage } from "./mf_line.ts";

const MF_OPENAI_KEY = Deno.env.get("OPENAI_API_KEY") || "";
const MF_IMAGE_MODEL = Deno.env.get("MF_IMAGE_MODEL") || "gpt-image-1"; // 可在 Supabase Secrets 切換新模型

export function mfStamp() {
  return `${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
}

function mfDecodeB64(b64: string) {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

// 存到 Storage;超過 1MB 另做縮圖給 LINE 的 previewImageUrl
export async function mfStoreForLine(prefix: string, bytes: Uint8Array, contentType: string) {
  const ext = contentType.includes("png") ? "png" : "jpg";
  const url = await mfUploadImage(`${prefix}.${ext}`, bytes, contentType);
  if (bytes.length <= 1_000_000) return { url, preview: url };
  const { Image } = await import("npm:imagescript@1.3.0");
  const img = await Image.decode(bytes);
  img.resize(480, Image.RESIZE_AUTO);
  const preview = await mfUploadImage(`${prefix}_p.jpg`, await img.encodeJPEG(80), "image/jpeg");
  return { url, preview };
}

// 修改/整合既有圖片:OpenAI images/edits(可一次放多張參考圖)
async function mfOpenAIEdit(prompt: string, sources: Uint8Array[]) {
  const send = (withFidelity: boolean) => {
    const form = new FormData();
    form.append("model", MF_IMAGE_MODEL);
    form.append("prompt", prompt);
    sources.forEach((src, i) => {
      const isPng = src[0] === 0x89 && src[1] === 0x50; // PNG 檔頭
      form.append("image[]", new Blob([src as BlobPart], { type: isPng ? "image/png" : "image/jpeg" }), `source${i}.${isPng ? "png" : "jpg"}`);
    });
    form.append("size", "1024x1024");
    form.append("quality", "high");
    form.append("output_format", "jpeg");
    if (withFidelity) form.append("input_fidelity", "high"); // 盡量保留原照片人物樣貌
    return fetch("https://api.openai.com/v1/images/edits", {
      method: "POST", headers: { Authorization: `Bearer ${MF_OPENAI_KEY}` }, body: form,
    });
  };
  let r = await send(true);
  if (r.status === 400) r = await send(false); // 模型不支援 input_fidelity 時退回
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d?.error?.message || `OpenAI 錯誤(${r.status})`);
  const b64 = d?.data?.[0]?.b64_json;
  if (!b64) throw new Error("沒有取得圖片");
  return { bytes: mfDecodeB64(b64), contentType: "image/jpeg" };
}

async function mfOpenAIImage(prompt: string, sources?: Uint8Array[]) {
  if (sources?.length) return await mfOpenAIEdit(prompt, sources);
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
  return { bytes: mfDecodeB64(b64), contentType };
}

// 產生(或依參考圖修改)→ 存檔 → 回傳圖片與說明;extra 可附加訊息(例如快速選項)
export async function mfGenerateAndSend(
  replyToken: string, userId: string, prompt: string, prefix: string, caption: string,
  sources?: Uint8Array[], extra: MfMessage[] = [],
) {
  try {
    const { bytes, contentType } = await mfOpenAIImage(prompt, sources);
    const { url, preview } = await mfStoreForLine(`${prefix}/${mfStamp()}`, bytes, contentType);
    await mfReplyOrPush(replyToken, userId, [mfImage(url, preview), mfText(caption), ...extra]);
    return { url, preview };
  } catch (e) {
    await mfReplyOrPush(replyToken, userId, [mfText(`圖片生成失敗:${(e as Error).message}`)]);
    return null;
  }
}

export async function mfLogImage(ownerId: string, img: { url: string; preview: string }, request: string) {
  await mfDb.from("mf_image_logs").insert({ owner_id: ownerId, url: img.url, preview_url: img.preview, request });
}
