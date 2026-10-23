// moneyfree 共用設定與工具(LIFF 初始化、呼叫後端 API)
const MF_CONFIG = {
  apiUrl: 'https://rztsilpmkygnybahiajy.supabase.co/functions/v1/mf-api',
  liffHalf: '2011977982-TKjnvFHN',
  liffFull: '2011977982-Oqw2Ao0M',
  contactUrl: 'https://line.me/ti/p/KSNRRjbTdX',
};

// ?mf_preview=1:不登入 LINE、不寫入資料庫,只供瀏覽器預覽版面
const mfPreview = new URLSearchParams(location.search).get('mf_preview') === '1';
let mfIdToken = null;

async function mfInit(mfLiffId) {
  if (mfPreview) return { mfName: '預覽模式', mfPreview: true };
  if (typeof liff === 'undefined') throw new Error('LINE 元件載入失敗,請重新開啟');
  await liff.init({ liffId: mfLiffId });
  if (!liff.isLoggedIn()) {
    liff.login({ redirectUri: location.href });
    return new Promise(() => {}); // 等待導向
  }
  mfIdToken = liff.getIDToken();
  if (!mfIdToken) throw new Error('無法取得登入資訊,請確認 LIFF 已開啟 openid 權限');
  const mfDecoded = liff.getDecodedIDToken() || {};
  return { mfName: mfDecoded.name || '', mfPreview: false };
}

async function mfApi(mfAction, mfPayload = {}) {
  if (mfPreview) return { mfPreview: true };
  const mfRes = await fetch(MF_CONFIG.apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: mfAction, idToken: mfIdToken, ...mfPayload }),
  });
  const mfData = await mfRes.json().catch(() => ({}));
  if (!mfRes.ok) {
    const mfErr = new Error(mfData.error || `伺服器錯誤(${mfRes.status})`);
    mfErr.mfStatus = mfRes.status;
    mfErr.mfData = mfData;
    throw mfErr;
  }
  return mfData;
}

function mfToast(mfMsg) {
  const mfEl = document.createElement('div');
  mfEl.className = 'mf-toast';
  mfEl.textContent = mfMsg;
  document.body.appendChild(mfEl);
  setTimeout(() => mfEl.remove(), 2600);
}

function mfShow(mfId, mfVisible = true) {
  document.getElementById(mfId).classList.toggle('mf-hidden', !mfVisible);
}

function mfEsc(mfStr) {
  return String(mfStr ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function mfClose() {
  if (!mfPreview && typeof liff !== 'undefined' && liff.isInClient()) liff.closeWindow();
  else history.back();
}
