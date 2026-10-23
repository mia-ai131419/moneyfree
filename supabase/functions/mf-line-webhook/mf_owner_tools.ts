// moneyfree 擁有者專用指令:圖文、圖片修改、群發、設計模板
import { mfDb, mfLine, mfReply, mfReplyOrPush, mfShowLoading, mfText } from "./mf_line.ts";
import { mfGenerateAndSend, mfLogImage, mfStamp, mfStoreForLine } from "./mf_image_gen.ts";
import { MF_MAX_IMAGES, mfBroadcastConfirm, mfBroadcastPreview, mfClearDraft, mfDraftImages } from "./mf_broadcast.ts";
import { mfAskImageChoice, mfComposeImage, mfGetState } from "./mf_compose.ts";

const MF_OPENAI_KEY = Deno.env.get("OPENAI_API_KEY") || "";
const MF_LIFF_FULL = "2011977982-Oqw2Ao0M";
export const MF_HELP_TEXT = `【擁有者指令】
・直接輸入問題:AI 金融助理
・圖文 需求:選擇「群發」(產生圖文後預覽群發)或「修改圖文」(上傳 1–4 張照片整合成專業圖文)
・直接貼網址:讀取網頁內容後同樣走圖文流程
・圖片修改 需求:修改上一張產生的圖片
・群發這張:把最近一張圖文放進群發預覽
・傳照片:暫存要群發的照片(最多 4 張)
・群發 文字:預覽群發內容(要以「群發」開頭)
・確認群發 / 取消群發
・財務表格:查看所有使用者財務健康度分數與分佈
・設計 需求(可省略):AI 產生介面配色模板
・更新選單:重新上傳圖文選單`;

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
  const img = await mfGenerateAndSend(replyToken, userId, String(spec.image_prompt || "luxury fintech mobile UI mockup, silver background, gold primary, light blue accent"), "design", summary);
  await mfDb.from("mf_design_drafts").insert({ request: request || null, spec, mockup_url: img?.url || null });
}

// 擁有者傳照片:圖文流程收素材中 → 當素材;否則 → 群發草稿
export async function mfOwnerImage(ev: Record<string, any>, ownerId: string) {
  const state = await mfGetState(ownerId);
  if (state?.mode === "collect_photos") { await mfComposeImage(ev, ownerId, state.request); return; }
  const have = (await mfDraftImages(ownerId)).length;
  if (have >= MF_MAX_IMAGES) {
    await mfReply(ev.replyToken, `群發最多 ${MF_MAX_IMAGES} 張照片,這張沒有加入。輸入「取消群發」可重來。`);
    return;
  }
  const r = await mfLine(`/v2/bot/message/${ev.message.id}/content`, {}, "api-data.line.me");
  if (!r.ok) { await mfReply(ev.replyToken, "照片下載失敗,請重傳一次"); return; }
  const contentType = r.headers.get("content-type") || "image/jpeg";
  const { url, preview } = await mfStoreForLine(`broadcast/${mfStamp()}`, new Uint8Array(await r.arrayBuffer()), contentType);
  await mfDb.from("mf_broadcast_images").insert({ owner_id: ownerId, url, preview_url: preview, purpose: "broadcast" });
  await mfReply(ev.replyToken, `已暫存第 ${have + 1} 張照片(最多 ${MF_MAX_IMAGES} 張)。\n輸入「群發 要說的話」預覽,或「取消群發」放棄。`);
}

// 回傳 Promise 表示已處理;回傳 null 表示不是擁有者指令(交給 AI 助理)
export function mfOwnerCommand(ev: Record<string, any>, ownerId: string, text: string): Promise<unknown> | null {
  const token = ev.replyToken as string;
  if (text === "指令" || text === "說明") return mfReply(token, MF_HELP_TEXT);
  if (text === "財務表格" || text === "財務健康度表格") {
    return mfReply(token, `【使用者財務健康度表格】(僅擁有者可開啟)\nhttps://liff.line.me/${MF_LIFF_FULL}/owner_report.html`);
  }

  const isUrlOnly = /^https?:\/\/\S+$/i.test(text); // 只貼網址也視為「圖文」
  if (text.startsWith("圖文") || isUrlOnly) {
    return mfAskImageChoice(token, ownerId, isUrlOnly ? text : text.slice(2).trim());
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
      const caption = "圖片修改完成 ✅\n可以繼續輸入「圖片修改 需求」再調整,或輸入「群發這張」\n長按可儲存或轉傳";
      const img = await mfGenerateAndSend(token, ownerId, prompt, "gen", caption, [new Uint8Array(await src.arrayBuffer())]);
      if (img) await mfLogImage(ownerId, img, `修改:${request}`);
    })();
  }

  if (text.startsWith("設計")) {
    return (async () => {
      await mfShowLoading(ownerId);
      await mfDesignTemplate(token, ownerId, text.replace(/^設計(模板)?/, "").trim());
    })();
  }

  if (text === "取消群發") return mfClearDraft(ownerId).then(() => mfReply(token, "已清除群發草稿"));
  if (text === "確認群發") return mfBroadcastConfirm(token, ownerId);

  if (text.startsWith("群發")) {
    return (async () => {
      const body = text.slice(2).trim();
      const images = await mfDraftImages(ownerId);
      if (!images.length && !body) { await mfReply(token, "請先傳要群發的照片,或輸入「群發 要說的話」"); return; }
      await mfBroadcastPreview(token, ownerId, body || null);
    })();
  }
  return null;
}
