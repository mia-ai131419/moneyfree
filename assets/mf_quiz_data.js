// 財務健康度檢測題庫:每個選項對 5 個維度加分(0–3)
// flex 財務彈性度、stress 可承受壓力度、ret 投資回報程度、health 資產健康程度、growth 資產成長度
const MF_DIMS = [
  ['flex', '財務彈性度'], ['stress', '可承受壓力度'], ['ret', '投資回報程度'],
  ['health', '資產健康程度'], ['growth', '資產成長度'],
];

const MF_QUESTIONS = [
  { q: '突然收到一筆等於 3 個月薪水的獎金,你的第一個念頭是?', o: [
    ['終於可以買想要很久的東西!', {}],
    ['先存起來,當作緊急預備金', { flex: 3, health: 2 }],
    ['投入早就研究好的投資標的', { growth: 3, ret: 2 }],
    ['一半存起來、一半拿去投資', { flex: 2, growth: 2, health: 2 }],
  ] },
  { q: '如果明天開始突然沒有收入,你的生活可以撐多久?', o: [
    ['一個月內就會很吃緊', {}],
    ['大概 3 個月', { flex: 1, stress: 1 }],
    ['半年左右', { flex: 2, stress: 2 }],
    ['一年以上都沒問題', { flex: 3, stress: 3 }],
  ] },
  { q: '你的資產每個月「自己長出來」的錢(股息、租金、利息),跟你的生活開銷比起來?', o: [
    ['幾乎沒有,全部靠薪水', {}],
    ['有一點,但遠遠不夠', { growth: 1, health: 1 }],
    ['可以支付部分固定開銷', { growth: 2, health: 2 }],
    ['已經能支付大部分生活費', { growth: 3, health: 3 }],
  ] },
  { q: '需要一筆錢的時候,你通常怎麼做?', o: [
    ['直接動用存款本金,花了再說', { flex: 1 }],
    ['先刷卡分期', {}],
    ['用事先準備好的生活帳戶', { health: 2, flex: 2 }],
    ['用被動收入支應,本金不動', { health: 3, growth: 2 }],
  ] },
  { q: '你手上的投資商品,你能說出它「一年大概賺多少、最壞可能虧多少」嗎?', o: [
    ['完全說不出來', {}],
    ['只知道應該會賺,不清楚風險', { ret: 1 }],
    ['知道預期報酬,也大概知道風險', { ret: 2 }],
    ['報酬、風險、費用都一清二楚', { ret: 3 }],
  ] },
  { q: '你期待一筆投資一年後的報酬是?', o: [
    ['越多越好,最好翻倍', {}],
    ['至少要 14% 以上', { ret: 1 }],
    ['穩穩的 5%–8% 就很滿意', { ret: 3, stress: 2 }],
    ['沒想過,交給專員處理', {}],
  ] },
  { q: '投資的帳面突然跌了 20%,你會?', o: [
    ['睡不著,馬上全部賣掉', {}],
    ['很焦慮,先賣掉一部分', { stress: 1 }],
    ['有點不安,但先不動', { stress: 2 }],
    ['照原本計畫,甚至考慮加碼', { stress: 3, growth: 1 }],
  ] },
  { q: '你的負債狀況比較像哪一種?', o: [
    ['卡費常常只繳最低應繳', {}],
    ['有好幾筆貸款,壓力不小', { health: 1, stress: 1 }],
    ['只有房貸等長期貸款,繳得很穩', { health: 2, stress: 2 }],
    ['幾乎沒有負債', { health: 3, stress: 3 }],
  ] },
  { q: '回頭看過去 3 年,你的總資產變化是?', o: [
    ['變少了', {}],
    ['差不多', { growth: 1 }],
    ['有慢慢增加', { growth: 2 }],
    ['明顯成長', { growth: 3 }],
  ] },
  { q: '每個月領到薪水後,你的順序是?', o: [
    ['先花,剩下的才存', {}],
    ['偶爾記得存一點', { flex: 1, growth: 1 }],
    ['固定先存一筆', { flex: 2, growth: 2 }],
    ['自動轉存 + 自動投資', { flex: 3, growth: 3, health: 1 }],
  ] },
];

const MF_PERSONAS = [
  { min: 80, icon: '🦁', name: '財務領航者', desc: '你的財務體質非常健康,有餘裕、懂風險,也讓資產持續成長。下一步是讓配置更有效率、做好傳承規劃。' },
  { min: 60, icon: '🐘', name: '穩健築城者', desc: '你已經打好不錯的基礎,只要補強較弱的一環,城牆就會更堅固。' },
  { min: 40, icon: '🦊', name: '潛力探索者', desc: '你有意識在理財,但安全網和方向感還不夠穩。建立預備金與清楚的投資目標,會讓你進步很快。' },
  { min: 0, icon: '🐣', name: '重新起步者', desc: '現在正是重新整理財務的好時機。從記帳、預備金、了解手上商品開始,一步一步就會看見改變。' },
];

const MF_DIM_TIPS = {
  flex: '建議先準備 3–6 個月生活費的緊急預備金,並把「先存再花」設成自動轉帳。',
  stress: '降低高利負債、確認保障足夠,面對市場波動時就不會被迫賣在低點。',
  ret: '把手上每個商品的預期報酬、最大風險、費用寫下來,看不懂的就找專員一起檢視。',
  health: '試著讓被動收入支付固定開銷,而不是動用本金,資產才會越用越健康。',
  growth: '設定定期定額與長期目標,讓時間與複利幫你累積資產。',
};

function mfScoreQuiz(mfAnswers) {
  const mfSum = {}; const mfMax = {};
  MF_DIMS.forEach(([k]) => { mfSum[k] = 0; mfMax[k] = 0; });
  MF_QUESTIONS.forEach((qq, i) => {
    MF_DIMS.forEach(([k]) => {
      mfMax[k] += Math.max(...qq.o.map((o) => o[1][k] || 0));
      const pick = qq.o[mfAnswers[i]];
      if (pick) mfSum[k] += pick[1][k] || 0;
    });
  });
  const mfDims = {};
  MF_DIMS.forEach(([k]) => { mfDims[k] = mfMax[k] ? Math.round((mfSum[k] / mfMax[k]) * 100) : 0; });
  const mfAvg = Math.round(MF_DIMS.reduce((s, [k]) => s + mfDims[k], 0) / MF_DIMS.length);
  const mfPersona = MF_PERSONAS.find((p) => mfAvg >= p.min);
  const mfWeak = [...MF_DIMS].sort((a, b) => mfDims[a[0]] - mfDims[b[0]]).slice(0, 2).map(([k]) => k);
  return { mfDims, mfAvg, mfPersona, mfWeak };
}
