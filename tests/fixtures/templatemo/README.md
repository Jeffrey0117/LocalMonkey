# templatemo 的真實 HTML（2026-11-18 抓的）

`curl https://templatemo.com/`、`/page/1`、`/tm-634-lantern-river` 的原樣輸出，
一個 byte 都沒改。SPEC-rules §3 的那一組規則就是對著這三頁寫的，
`tests/integration/rules-templatemo.test.js` 逐條驗它。

**不要「整理」這些檔案**（同 `tests/fixtures/real-userscripts/` 的紀律）：
它們的價值就在於保留了真實頁面的怪東西 ——

- 詳情頁有**兩個元素共用 `id="tm-download"`**（真的下載按鈕 + AI 提示生成器）。
  HTML 不合法，但瀏覽器的 CSS `#tm-download` 會兩個都命中，所以規則不能用那個 id。
- 標語前面有一個半形空白：`<h2 class="templatemo-slogan"> Free HTML...`。
- footer 的連結之間是**純文字節點的 ` - `**，CSS 藏不掉。
- logo 是 PNG（`/images/templatemo-logo-new.png`），文字替換換不掉它。
- 首頁的卡片標題沒有編號（`Lantern River`），`/page/1` 的才有（`634 Lantern River`）。
