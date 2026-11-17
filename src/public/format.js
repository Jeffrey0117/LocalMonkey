/* 後台儀表板的格式化與排序。純函式，沒有 DOM —— 所以單元測試在 vm 裡真的跑得動。 */
'use strict';

window.LocalMonkeyFormat = (function createFormat() {
  const UNITS = ['B', 'KB', 'MB', 'GB'];

  /**
   * 檔案大小。SPEC 要求「格式化成 KB」，所以 877 bytes 顯示成 `0.9 KB` 而不是 `877 B`
   * —— 整欄同一個單位才掃得過去（Tampermonkey 的「大小」欄就是這樣）。
   * 只有 0 例外，`0.0 KB` 看起來像壞掉。
   */
  function formatBytes(bytes) {
    if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '—';
    if (bytes === 0) return '0 B';

    const exponent = Math.min(
      Math.max(Math.floor(Math.log(bytes) / Math.log(1024)), 1),
      UNITS.length - 1,
    );

    return `${(bytes / 1024 ** exponent).toFixed(1)} ${UNITS[exponent]}`;
  }

  function parseTime(iso) {
    const time = typeof iso === 'string' ? Date.parse(iso) : NaN;
    return Number.isNaN(time) ? null : time;
  }

  /**
   * 「2 分鐘」「3 小時」「9 天」。
   * 不滿一分鐘一律「剛剛」—— 「0 分鐘」看起來像壞掉。
   * 未來時間（機器時鐘歪了、或剛存完的毫秒差）也當「剛剛」，不要出現負數。
   */
  function relativeTime(iso, now = Date.now()) {
    const time = parseTime(iso);
    if (time === null) return '—';

    const seconds = Math.max(0, Math.floor((now - time) / 1000));
    if (seconds < 60) return '剛剛';
    if (seconds < 3600) return `${Math.floor(seconds / 60)} 分鐘`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小時`;
    return `${Math.floor(seconds / 86400)} 天`;
  }

  /** 相對時間不精確，hover 的 title 要看得到原值 */
  function absoluteTime(iso) {
    const time = parseTime(iso);
    return time === null ? '' : new Date(time).toLocaleString();
  }

  /**
   * 版本號要一段一段比數字：字串比的話 `1.10.0` 會小於 `1.9.0`。
   * 比不出來的段落退回字串比較（`1.0-beta` 這種）。
   */
  function compareVersions(a, b) {
    const left = String(a).split(/[.\-+]/);
    const right = String(b).split(/[.\-+]/);

    for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
      const x = left[index] ?? '';
      const y = right[index] ?? '';
      const numeric = Number(x) - Number(y);

      if (Number.isFinite(numeric) && numeric !== 0) return numeric;
      if (!Number.isFinite(numeric) && x !== y) return x < y ? -1 : 1;
    }

    return 0;
  }

  function compareText(a, b) {
    // 不分大小寫：不然 `apple` 會被排到所有大寫名字後面
    const left = String(a ?? '').toLowerCase();
    const right = String(b ?? '').toLowerCase();
    if (left === right) return 0;
    return left < right ? -1 : 1;
  }

  function compareNumbers(a, b) {
    return (Number(a) || 0) - (Number(b) || 0);
  }

  const COMPARATORS = {
    order_index: (a, b) => compareNumbers(a.order_index, b.order_index),
    name: (a, b) => compareText(a.name, b.name),
    version: (a, b) => compareVersions(a.version, b.version),
    size: (a, b) => compareNumbers(a.size, b.size),
    updatedAt: (a, b) => compareNumbers(Date.parse(a.updatedAt), Date.parse(b.updatedAt)),
  };

  /** 空值永遠沉底，不管升冪降冪 —— 插在中間的話使用者會以為資料壞了 */
  function isEmpty(value) {
    return value === null || value === undefined || value === '';
  }

  /**
   * @returns {object[]} **新陣列**（呼叫端的 state 不可以被就地改掉）
   */
  function sortRows(rows, key, direction = 'asc') {
    const list = Array.isArray(rows) ? [...rows] : [];
    const compare = COMPARATORS[key];
    if (!compare) return list;

    const sign = direction === 'desc' ? -1 : 1;

    return list.sort((a, b) => {
      const emptyA = isEmpty(a[key]);
      const emptyB = isEmpty(b[key]);
      if (emptyA !== emptyB) return emptyA ? 1 : -1;
      if (emptyA && emptyB) return 0;

      return compare(a, b) * sign;
    });
  }

  return { formatBytes, relativeTime, absoluteTime, sortRows, compareVersions };
})();
