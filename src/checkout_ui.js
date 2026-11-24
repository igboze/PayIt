// src/checkout_ui.js
// White-Labeled Hosted Checkout Page (/checkout/:sessionId),
// Reusable Payment Link Page (/pay/:slug),
// and Drop-in Inline Embed JS SDK (/sdk/proxim-checkout.js).

function esc(str) {
  if (str == null) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fmtAmount(amount, currency = "USD") {
  const cur = String(currency || "USD").toUpperCase();
  const n = Number(amount || 0);
  const syms = { NGN: "₦", USD: "$", GBP: "£", EUR: "€", AED: "AED ", KES: "KSh ", GHS: "GH₵" };
  const s = syms[cur] || "";
  const formatted = n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return s ? `${s}${formatted}${cur === "NGN" ? "" : " " + cur}` : `${formatted} ${cur}`;
}

/**
 * Render the merchant-branded Hosted Checkout HTML page for `session`.
 */
function renderCheckoutPageHtml(session, baseUrl = "") {
  const brand = session.brand || {};
  const primary = brand.primaryColor || "#0f172a";
  const accent = brand.accentColor || "#059669";
  const bizName = brand.businessName || "Proxim Merchant";
  const logoSrc = brand.logoUrl || brand.logoDataUri || null;
  const initial = (bizName.replace(/[^A-Za-z0-9]/g, "")[0] || "P").toUpperCase();
  const pm = session.paymentMethods || {};

  const tabs = [];
  if (pm.ngnBank) tabs.push({ id: "ngnBank", label: "🇳🇬 Bank Transfer (NGN)" });
  if (pm.globalBank) tabs.push({ id: "globalBank", label: `🏦 ${esc(pm.globalBank.currency)} Bank Transfer` });
  if (pm.crypto) tabs.push({ id: "crypto", label: `🌐 Crypto (${esc(pm.crypto.chainLabel)})` });

  const logoHtml = logoSrc
    ? `<img src="${esc(logoSrc)}" alt="${esc(bizName)}" class="logo-img"/>`
    : `<div class="logo-mono">${esc(initial)}</div>`;

  const ngnPanel = pm.ngnBank
    ? `
    <div class="panel" id="panel-ngnBank">
      <div class="hint">Transfer the <b>exact amount</b> below to this dedicated virtual account:</div>
      <div class="field"><span class="lbl">Bank Name</span><span class="val">${esc(pm.ngnBank.bankName)}</span></div>
      <div class="field"><span class="lbl">Account Number</span><span class="val mono">${esc(pm.ngnBank.accountNumber)} <button class="copy-btn" onclick="copyText('${esc(pm.ngnBank.accountNumber)}', this)">Copy</button></span></div>
      <div class="field"><span class="lbl">Account Name</span><span class="val">${esc(pm.ngnBank.accountName)}</span></div>
      <div class="field"><span class="lbl">Exact Amount</span><span class="val accent mono">₦${Number(pm.ngnBank.amountNgn || 0).toLocaleString("en-NG")} <button class="copy-btn" onclick="copyText('${Number(pm.ngnBank.amountNgn || 0)}', this)">Copy</button></span></div>
    </div>`
    : "";

  const globalBankPanel = pm.globalBank
    ? `
    <div class="panel" id="panel-globalBank">
      <div class="hint">Send via <b>${esc(pm.globalBank.railHint || "Bank Transfer")}</b> (${esc(pm.globalBank.currency)}):</div>
      <div class="field"><span class="lbl">Bank Name</span><span class="val">${esc(pm.globalBank.bankName)}</span></div>
      <div class="field"><span class="lbl">Beneficiary</span><span class="val">${esc(pm.globalBank.accountName)}</span></div>
      ${pm.globalBank.accountNumber ? `<div class="field"><span class="lbl">Account No</span><span class="val mono">${esc(pm.globalBank.accountNumber)} <button class="copy-btn" onclick="copyText('${esc(pm.globalBank.accountNumber)}', this)">Copy</button></span></div>` : ""}
      ${pm.globalBank.iban ? `<div class="field"><span class="lbl">IBAN</span><span class="val mono">${esc(pm.globalBank.iban)} <button class="copy-btn" onclick="copyText('${esc(pm.globalBank.iban)}', this)">Copy</button></span></div>` : ""}
      ${pm.globalBank.routingNumber ? `<div class="field"><span class="lbl">Routing No</span><span class="val mono">${esc(pm.globalBank.routingNumber)} <button class="copy-btn" onclick="copyText('${esc(pm.globalBank.routingNumber)}', this)">Copy</button></span></div>` : ""}
      ${pm.globalBank.sortCode ? `<div class="field"><span class="lbl">Sort Code</span><span class="val mono">${esc(pm.globalBank.sortCode)} <button class="copy-btn" onclick="copyText('${esc(pm.globalBank.sortCode)}', this)">Copy</button></span></div>` : ""}
      ${pm.globalBank.swiftCode ? `<div class="field"><span class="lbl">SWIFT / BIC</span><span class="val mono">${esc(pm.globalBank.swiftCode)} <button class="copy-btn" onclick="copyText('${esc(pm.globalBank.swiftCode)}', this)">Copy</button></span></div>` : ""}
    </div>`
    : "";

  const cryptoPanel = pm.crypto
    ? `
    <div class="panel" id="panel-crypto">
      <div class="hint">Send exact <b>${Number(pm.crypto.exactAmount).toFixed(2)} ${esc(pm.crypto.tokenSymbol)}</b> on <b>${esc(pm.crypto.chainLabel)}</b>${pm.crypto.viaNearIntents ? " (NEAR Intents)" : ""}:</div>
      ${pm.crypto.qrDataUri ? `<div class="qr-wrap"><img src="${pm.crypto.qrDataUri}" alt="QR" class="qr-img"/></div>` : ""}
      <div class="field"><span class="lbl">Network</span><span class="val">${esc(pm.crypto.chainLabel)} (${esc(pm.crypto.tokenSymbol)})</span></div>
      <div class="field"><span class="lbl">Deposit Address</span><span class="val mono addr">${esc(pm.crypto.depositAddress)} <button class="copy-btn" onclick="copyText('${esc(pm.crypto.depositAddress)}', this)">Copy</button></span></div>
      ${pm.crypto.depositMemo ? `<div class="field"><span class="lbl">Memo / Tag</span><span class="val mono">${esc(pm.crypto.depositMemo)} <button class="copy-btn" onclick="copyText('${esc(pm.crypto.depositMemo)}', this)">Copy</button></span></div>` : ""}
    </div>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Pay ${esc(bizName)} — ${esc(fmtAmount(session.amount, session.currency))}</title>
  <style>
    :root { --primary: ${esc(primary)}; --accent: ${esc(accent)}; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f1f5f9; color: #0f172a; display: flex; min-height: 100vh; align-items: center; justify-content: center; padding: 20px; }
    .card { width: 100%; max-width: 460px; background: #fff; border-radius: 18px; box-shadow: 0 20px 50px rgba(15,23,42,0.08); overflow: hidden; border: 1px solid #e2e8f0; }
    .ribbon { height: 6px; background: linear-gradient(90deg, var(--primary), var(--accent)); }
    .hdr { padding: 22px 24px 16px; display: flex; align-items: center; gap: 14px; border-bottom: 1px solid #f1f5f9; }
    .logo-img { width: 44px; height: 44px; border-radius: 10px; object-fit: contain; border: 1px solid #e2e8f0; padding: 4px; background: #fff; }
    .logo-mono { width: 44px; height: 44px; border-radius: 10px; background: linear-gradient(135deg, var(--primary), var(--accent)); color: #fff; display: flex; align-items: center; justify-content: center; font-weight: 800; font-size: 20px; }
    .biz { font-weight: 700; font-size: 16px; }
    .desc { font-size: 13px; color: #64748b; margin-top: 2px; }
    .hero { padding: 18px 24px; background: #f8fafc; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #e2e8f0; }
    .amt-lbl { font-size: 11px; font-weight: 700; letter-spacing: .08em; color: #94a3b8; text-transform: uppercase; }
    .amt-val { font-size: 26px; font-weight: 800; color: var(--primary); margin-top: 2px; }
    .status-pill { font-size: 11px; font-weight: 700; padding: 5px 10px; border-radius: 999px; background: #ecfdf5; color: var(--accent); border: 1px solid #a7f3d0; }
    .tabs { display: flex; gap: 6px; padding: 14px 20px 0; flex-wrap: wrap; }
    .tab { flex: 1; min-width: 110px; padding: 9px 10px; font-size: 12px; font-weight: 700; border-radius: 10px; border: 1px solid #e2e8f0; background: #fff; color: #475569; cursor: pointer; text-align: center; }
    .tab.active { background: var(--primary); color: #fff; border-color: var(--primary); }
    .panel { display: none; padding: 18px 24px 20px; }
    .panel.active { display: block; }
    .hint { font-size: 13px; color: #475569; margin-bottom: 14px; }
    .field { display: flex; justify-content: space-between; align-items: center; gap: 10px; padding: 10px 12px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; margin-bottom: 8px; font-size: 13px; }
    .lbl { color: #64748b; font-weight: 600; flex-shrink: 0; }
    .val { font-weight: 700; text-align: right; word-break: break-all; }
    .val.accent { color: var(--accent); }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
    .addr { font-size: 11px; }
    .copy-btn { margin-left: 6px; padding: 3px 8px; font-size: 11px; font-weight: 700; border-radius: 6px; border: 1px solid #cbd5e1; background: #fff; color: var(--primary); cursor: pointer; }
    .qr-wrap { text-align: center; margin-bottom: 14px; }
    .qr-img { width: 170px; height: 170px; border-radius: 12px; border: 1px solid #e2e8f0; padding: 8px; background: #fff; }
    .paid-box { display: none; padding: 36px 24px; text-align: center; }
    .paid-box.show { display: block; }
    .paid-icon { font-size: 48px; margin-bottom: 10px; }
    .ftr { padding: 14px 24px; border-top: 1px solid #f1f5f9; text-align: center; font-size: 12px; color: #64748b; font-weight: 600; }
    .dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: var(--accent); margin-right: 6px; vertical-align: middle; }
  </style>
</head>
<body>
  <div class="card">
    <div class="ribbon"></div>
    <div class="hdr">
      ${logoHtml}
      <div>
        <div class="biz">${esc(bizName)}</div>
        ${session.description ? `<div class="desc">${esc(session.description)}</div>` : ""}
      </div>
    </div>
    <div class="hero">
      <div>
        <div class="amt-lbl">Amount Due</div>
        <div class="amt-val">${esc(fmtAmount(session.amount, session.currency))}</div>
      </div>
      <div class="status-pill" id="statusPill">${session.status === "paid" ? "PAID" : "AWAITING PAYMENT"}</div>
    </div>

    <div id="checkoutBody" style="${session.status === "paid" ? "display:none" : ""}">
      ${tabs.length > 1 ? `<div class="tabs">${tabs.map((t, i) => `<button class="tab ${i === 0 ? "active" : ""}" onclick="selectTab('${t.id}', this)">${t.label}</button>`).join("")}</div>` : ""}
      ${ngnPanel}
      ${globalBankPanel}
      ${cryptoPanel}
    </div>

    <div class="paid-box ${session.status === "paid" ? "show" : ""}" id="paidBox">
      <div class="paid-icon">✅</div>
      <h2 style="margin:0 0 6px">Payment Confirmed!</h2>
      <p style="color:#64748b;font-size:14px;margin:0">Thank you for paying ${esc(bizName)}.</p>
    </div>

    <div class="ftr"><span class="dot"></span>Powered by Proxim</div>
  </div>
  <script>
    const firstTab = ${JSON.stringify(tabs[0]?.id || "")};
    if (firstTab) {
      const p = document.getElementById("panel-" + firstTab);
      if (p) p.classList.add("active");
    }
    function selectTab(id, btn) {
      document.querySelectorAll(".panel").forEach(el => el.classList.remove("active"));
      document.querySelectorAll(".tab").forEach(el => el.classList.remove("active"));
      const p = document.getElementById("panel-" + id);
      if (p) p.classList.add("active");
      if (btn) btn.classList.add("active");
    }
    function copyText(val, btn) {
      navigator.clipboard.writeText(val).then(() => {
        const orig = btn.textContent;
        btn.textContent = "Copied!";
        setTimeout(() => btn.textContent = orig, 1400);
      });
    }
    const sessionId = ${JSON.stringify(session.sessionId)};
    const successUrl = ${JSON.stringify(session.successUrl || "")};
    const pollUrl = ${JSON.stringify(`${baseUrl.replace(/\/+$/, "")}/api/v1/checkout/public/${session.sessionId}`)};
    let currentStatus = ${JSON.stringify(session.status)};
    if (currentStatus === "open") {
      const timer = setInterval(async () => {
        try {
          const r = await fetch(pollUrl);
          const d = await r.json();
          if (d && d.status === "paid") {
            clearInterval(timer);
            document.getElementById("checkoutBody").style.display = "none";
            document.getElementById("paidBox").classList.add("show");
            document.getElementById("statusPill").textContent = "PAID";
            try { window.parent.postMessage({ type: "proxim:payment.succeeded", session: d }, "*"); } catch (_) {}
            if (successUrl) setTimeout(() => { window.location.href = successUrl; }, 1800);
          }
        } catch (_) {}
      }, 4000);
    }
  </script>
</body>
</html>`;
}

/**
 * Render the Reusable Payment Link landing page (/pay/:slug).
 */
function renderPaymentLinkHtml(link, baseUrl = "") {
  const brand = link.brand || {};
  const primary = brand.primaryColor || "#0f172a";
  const accent = brand.accentColor || "#059669";
  const bizName = brand.businessName || link.title;
  const fixedAmt = link.amount != null;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>${esc(link.title)} — Proxim Pay</title>
  <style>
    :root { --primary: ${esc(primary)}; --accent: ${esc(accent)}; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f1f5f9; color: #0f172a; display: flex; min-height: 100vh; align-items: center; justify-content: center; padding: 20px; }
    .card { width: 100%; max-width: 420px; background: #fff; border-radius: 18px; box-shadow: 0 20px 50px rgba(15,23,42,0.08); overflow: hidden; border: 1px solid #e2e8f0; }
    .ribbon { height: 6px; background: linear-gradient(90deg, var(--primary), var(--accent)); }
    .body { padding: 26px 24px; }
    h1 { margin: 0 0 6px; font-size: 20px; color: var(--primary); }
    p { margin: 0 0 18px; font-size: 13.5px; color: #64748b; }
    label { display: block; font-size: 12px; font-weight: 700; color: #475569; margin: 12px 0 6px; }
    input { width: 100%; padding: 11px 12px; border: 1px solid #cbd5e1; border-radius: 10px; font-size: 14px; }
    button { width: 100%; margin-top: 18px; padding: 13px; border: 0; border-radius: 12px; background: var(--primary); color: #fff; font-weight: 700; font-size: 15px; cursor: pointer; }
    .err { color: #dc2626; font-size: 12.5px; margin-top: 10px; display: none; }
    .ftr { padding: 14px 24px; border-top: 1px solid #f1f5f9; text-align: center; font-size: 12px; color: #64748b; font-weight: 600; }
  </style>
</head>
<body>
  <div class="card">
    <div class="ribbon"></div>
    <div class="body">
      <h1>${esc(link.title)}</h1>
      ${link.description ? `<p>${esc(link.description)}</p>` : `<p>Pay ${esc(bizName)} securely via bank transfer or crypto.</p>`}
      <form id="payForm">
        <label>Amount (${esc(link.currency)})</label>
        <input id="amount" type="number" step="0.01" required ${fixedAmt ? `value="${Number(link.amount)}" readonly` : `placeholder="Enter amount"`}/>
        <label>Your Name</label>
        <input id="name" type="text" placeholder="Full name" required/>
        <label>Your Email</label>
        <input id="email" type="email" placeholder="you@example.com" required/>
        <button type="submit" id="btn">Continue to Payment →</button>
        <div class="err" id="err"></div>
      </form>
    </div>
    <div class="ftr">Powered by Proxim</div>
  </div>
  <script>
    document.getElementById("payForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = document.getElementById("btn");
      const err = document.getElementById("err");
      err.style.display = "none";
      btn.disabled = true;
      btn.textContent = "Creating checkout…";
      try {
        const res = await fetch(${JSON.stringify(`${baseUrl.replace(/\/+$/, "")}/api/v1/payment-links/${link.slug}/checkout`)}, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            amount: Number(document.getElementById("amount").value),
            customerName: document.getElementById("name").value,
            customerEmail: document.getElementById("email").value,
          }),
        });
        const data = await res.json();
        if (!res.ok || !data.checkoutUrl) throw new Error(data.error || "Could not start checkout");
        window.location.href = data.checkoutUrl;
      } catch (ex) {
        err.textContent = ex.message;
        err.style.display = "block";
        btn.disabled = false;
        btn.textContent = "Continue to Payment →";
      }
    });
  </script>
</body>
</html>`;
}

/**
 * Lightweight drop-in JS Embed SDK (/sdk/proxim-checkout.js).
 * Usage on any merchant website:
 *   <script src="https://<host>/sdk/proxim-checkout.js"></script>
 *   ProximCheckout.open({ sessionId: "cs_live_...", onSuccess: (s) => {}, onClose: () => {} });
 */
function renderCheckoutSdkJs(baseUrl = "") {
  const origin = baseUrl.replace(/\/+$/, "");
  return `(function(global){
  const ORIGIN = ${JSON.stringify(origin)};
  function open(opts){
    if (!opts || !opts.sessionId) throw new Error("ProximCheckout.open requires sessionId");
    const overlay = document.createElement("div");
    overlay.style.cssText = "position:fixed;inset:0;background:rgba(15,23,42,0.65);z-index:999999;display:flex;align-items:center;justify-content:center;padding:16px;";
    const box = document.createElement("div");
    box.style.cssText = "position:relative;width:100%;max-width:480px;height:660px;max-height:92vh;background:#fff;border-radius:18px;overflow:hidden;box-shadow:0 25px 60px rgba(0,0,0,0.3);";
    const closeBtn = document.createElement("button");
    closeBtn.textContent = "✕";
    closeBtn.style.cssText = "position:absolute;top:10px;right:12px;z-index:2;border:0;background:#f1f5f9;width:30px;height:30px;border-radius:50%;cursor:pointer;font-weight:700;";
    const iframe = document.createElement("iframe");
    iframe.src = (opts.baseUrl || ORIGIN) + "/checkout/" + encodeURIComponent(opts.sessionId);
    iframe.style.cssText = "width:100%;height:100%;border:0;";
    function cleanup(){
      window.removeEventListener("message", onMsg);
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      if (typeof opts.onClose === "function") opts.onClose();
    }
    function onMsg(ev){
      if (ev && ev.data && ev.data.type === "proxim:payment.succeeded") {
        if (typeof opts.onSuccess === "function") opts.onSuccess(ev.data.session);
      }
    }
    closeBtn.onclick = cleanup;
    overlay.onclick = function(e){ if (e.target === overlay) cleanup(); };
    window.addEventListener("message", onMsg);
    box.appendChild(closeBtn);
    box.appendChild(iframe);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    return { close: cleanup };
  }
  global.ProximCheckout = { open: open };
})(window);`;
}

module.exports = {
  renderCheckoutPageHtml,
  renderPaymentLinkHtml,
  renderCheckoutSdkJs,
};
