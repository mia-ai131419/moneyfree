// moneyfree LINE Flex 卡片:品牌配色(金色主色、藍色配色、深藏青文字)
import { MfMessage } from "./mf_line.ts";

const MF_GOLD = "#C9A227";
const MF_NAVY = "#22324D";
const MF_BLUE = "#CCDDFF";
const MF_MUTED = "#5B6573";

export type MfButton = [label: string, text: string, primary?: boolean];

// 標題 + 說明 + 按鈕(按鈕送出的文字 = 指令,手打一樣有效)
export function mfCard(title: string, body: string, buttons: MfButton[], altText = title): MfMessage {
  return {
    type: "flex",
    altText: altText.slice(0, 380),
    contents: {
      type: "bubble",
      size: "kilo",
      header: {
        type: "box", layout: "vertical", backgroundColor: MF_GOLD, paddingAll: "14px",
        contents: [{ type: "text", text: title, weight: "bold", size: "lg", color: MF_NAVY, wrap: true }],
      },
      body: {
        type: "box", layout: "vertical", paddingAll: "14px",
        contents: [{ type: "text", text: body || " ", size: "sm", color: MF_MUTED, wrap: true }],
      },
      footer: {
        type: "box", layout: "vertical", spacing: "sm", paddingAll: "12px",
        contents: buttons.map(([label, text, primary]) => ({
          type: "button", height: "sm",
          style: primary === false ? "secondary" : "primary",
          color: primary === false ? MF_BLUE : MF_GOLD,
          action: { type: "message", label: label.slice(0, 20), text },
        })),
      },
    },
  };
}
