'use strict';

/**
 * 價格方案（SPEC-reskin §4.3）。
 *
 * ⛔ **上游沒有價格，價格是我們自己定的。** 所以它不屬於抽取層（那層是
 * 可拋棄的），而是商城機制的一部分 —— 存在 per-site 設定裡，之後換資料來源
 * 也照樣有效。
 *
 * ⛔ **v10 起，這裡的 `price` 就是真的會被扣的金額**（SPEC-checkout §2）。
 * 結帳時由伺服器端從這裡算（`price × 數量`），寫進 `reskin_orders.amount`，
 * 再加密進 TradeInfo 送去藍新；回呼回來還會跟訂單**再比對一次金額**。
 *
 * 所以改這個數字 ＝ 改收費。前端送什麼都不影響它 —— 瀏覽器只送得了
 * 「哪個方案、幾份」，金額自始至終沒離開過伺服器端
 * （`~/.claude/rules/infra-map.md` 的變現三件套：`price` 是後端算的）。
 *
 * `originalPrice`（劃線價）相反：它**只是行銷定錨**，不會被任何人收。
 */

const DEFAULT_CURRENCY = 'NT$';

/**
 * 預設**只有一檔**（SPEC-reskin-v2 §3）。
 *
 * ⛔ 使用者的話是「別分什麼個人企業，也別寫什麼授權的鬼」——
 * 所以商品頁就是一個價格、直接買，而且整個版型裡沒有「授權」這兩個字。
 * 資料結構留著吃得下多檔（之後可能真的要分級，`compilePricing` 的上限是
 * `MAX_PLANS`），但**預設不准長出第二檔** —— 版型看到只有一檔就不畫選擇區。
 *
 * `id` 是前端 localStorage 的 key，所以限定英數。
 */
const DEFAULT_PLANS = Object.freeze([
  Object.freeze({ id: 'standard', name: '單檔購買', price: 199, note: '' }),
]);

const MAX_PLANS = 8;
const MAX_PRICE = 9999999;

function fail(error) {
  return { ok: false, error };
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizePlan(plan, index) {
  if (!isPlainObject(plan)) return fail(`方案 ${index + 1}：必須是物件`);

  const { id, name, price } = plan;
  if (typeof id !== 'string' || !/^[a-zA-Z][\w-]{0,30}$/.test(id)) {
    return fail(`方案 ${index + 1}：id 只能是英數與 _ -，開頭是字母`);
  }
  if (typeof name !== 'string' || name.trim().length === 0 || name.length > 40) {
    return fail(`方案 ${index + 1}：name 必填，最長 40 字`);
  }
  if (!Number.isFinite(price) || price < 0 || price > MAX_PRICE) {
    return fail(`方案 ${index + 1}：price 必須是 0 ~ ${MAX_PRICE} 的數字`);
  }
  if (plan.note !== undefined && plan.note !== null && typeof plan.note !== 'string') {
    return fail(`方案 ${index + 1}：note 必須是字串`);
  }

  return {
    ok: true,
    value: {
      id,
      name: name.trim(),
      // 整數化：小數點後的金額在這個示範裡沒有意義，而「199.999」印出來很醜
      price: Math.round(price),
      note: typeof plan.note === 'string' ? plan.note.trim() : '',
    },
  };
}

/**
 * @param {unknown} source 物件、或它的 JSON 字串（DB 存字串）
 * @returns {{ ok: true, value: { currency: string, plans: Array<object> } }|{ ok: false, error: string }}
 */
function compilePricing(source) {
  if (source === undefined || source === null || source === '') {
    return { ok: true, value: { currency: DEFAULT_CURRENCY, plans: [...DEFAULT_PLANS] } };
  }

  let parsed = source;
  if (typeof source === 'string') {
    try {
      parsed = JSON.parse(source);
    } catch (error) {
      return fail(`不是合法的 JSON：${error.message}`);
    }
  }

  if (parsed === null) {
    return { ok: true, value: { currency: DEFAULT_CURRENCY, plans: [...DEFAULT_PLANS] } };
  }
  if (!isPlainObject(parsed)) return fail('價格設定必須是物件 { currency, plans }');

  const currency =
    typeof parsed.currency === 'string' && parsed.currency.trim().length > 0
      ? parsed.currency.trim().slice(0, 8)
      : DEFAULT_CURRENCY;

  if (parsed.plans === undefined || parsed.plans === null) {
    return { ok: true, value: { currency, plans: [...DEFAULT_PLANS] } };
  }
  if (!Array.isArray(parsed.plans)) return fail('plans 必須是陣列');
  if (parsed.plans.length === 0) return fail('至少要有一個方案');
  if (parsed.plans.length > MAX_PLANS) return fail(`最多 ${MAX_PLANS} 個方案`);

  const plans = parsed.plans.reduce(
    (acc, plan, index) => {
      if (!acc.ok) return acc;
      const normalized = normalizePlan(plan, index);
      if (!normalized.ok) return normalized;
      if (acc.value.some((kept) => kept.id === normalized.value.id)) {
        return fail(`方案 id「${normalized.value.id}」重複了`);
      }
      return { ok: true, value: [...acc.value, normalized.value] };
    },
    { ok: true, value: [] },
  );

  return plans.ok ? { ok: true, value: { currency, plans: plans.value } } : plans;
}

/**
 * 卡片上印的那個價格 ＝ **最便宜的付費方案**（沒有付費方案就拿第一個）。
 *
 * 為什麼不是「最貴的」或「第一個」：卡片是拉人點進去的，而 0 元印在卡片上
 * 看起來像壞掉。`原價` 用最貴的那檔當行銷定錨（劃線價），這跟
 * `paywall-kit` 的 `price` / `originalPrice` 是同一個分寸 —— 劃線價只是定錨，
 * 不是任何人會被收的錢。
 */
function headlinePrice(plans) {
  const paid = plans.filter((plan) => plan.price > 0);
  const cheapest = paid.length > 0 ? paid.reduce((low, plan) => (plan.price < low.price ? plan : low)) : plans[0];
  const dearest = plans.reduce((high, plan) => (plan.price > high.price ? plan : high), plans[0]);

  return {
    price: cheapest?.price ?? 0,
    originalPrice: dearest && dearest.price > (cheapest?.price ?? 0) ? dearest.price : null,
    hasFree: plans.some((plan) => plan.price === 0),
  };
}

module.exports = {
  compilePricing,
  headlinePrice,
  DEFAULT_PLANS,
  DEFAULT_CURRENCY,
  MAX_PLANS,
};
