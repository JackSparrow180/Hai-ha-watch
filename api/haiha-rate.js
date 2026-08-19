import puppeteer from "puppeteer-core";
import chromium from "@sparticuz/chromium";
import {
  deriveUsdToAudRate,
  isMaintenanceText,
  parseMoneyNumber,
} from "../lib/haiha-parser.js";

const CALCULATOR_URL = "https://app.hhmt.com.au/fx-calculator-form?lang=en";
const NAVIGATION_TIMEOUT_MS = 15000;
const ACTION_TIMEOUT_MS = 6500;
const QUOTE_USD_AMOUNT = 1500;

class HaiHaRateError extends Error {
  constructor(status, message, httpStatus = 503) {
    super(message);
    this.name = "HaiHaRateError";
    this.status = status;
    this.httpStatus = httpStatus;
  }
}

function log(step, detail = "") {
  const suffix = detail ? ` · ${detail}` : "";
  console.log(`[HaiHa] ${step}${suffix}`);
}

async function bodyText(page) {
  return page.evaluate(() => document.body?.innerText || "");
}

async function describeSellControl(handle) {
  return handle.evaluate((el) => {
    const className = typeof el.className === "string" ? el.className : "";
    const parentClass = typeof el.parentElement?.className === "string" ? el.parentElement.className : "";
    const input = el.matches?.("input") ? el : el.querySelector?.("input");
    return {
      text: (el.textContent || el.getAttribute?.("aria-label") || "").trim(),
      ariaSelected: el.getAttribute?.("aria-selected") || "",
      ariaPressed: el.getAttribute?.("aria-pressed") || "",
      ariaChecked: el.getAttribute?.("aria-checked") || "",
      dataState: el.getAttribute?.("data-state") || "",
      className,
      parentClass,
      checked: Boolean(input?.checked),
    };
  });
}

function looksActive(state) {
  if (!state) return false;
  if ([state.ariaSelected, state.ariaPressed, state.ariaChecked].some((v) => String(v).toLowerCase() === "true")) return true;
  if (/active|selected|current|checked|on/i.test(state.dataState || "")) return true;
  if (/\b(active|selected|current|checked|on)\b/i.test(`${state.className || ""} ${state.parentClass || ""}`)) return true;
  return Boolean(state.checked);
}

async function findSellControls(page) {
  const handles = await page.$$("button,[role='tab'],[role='button'],a,label,input[type='radio']");
  const matches = [];
  for (const handle of handles) {
    const state = await describeSellControl(handle).catch(() => null);
    if (!state) continue;
    if (/^(you\s*sell|sell|bạn\s*bán|ban\s*ban)$/i.test(state.text)) {
      matches.push({ handle, state });
    }
  }
  return matches;
}

async function verifySellMode(page) {
  const controls = await findSellControls(page);
  for (const item of controls) {
    const state = await describeSellControl(item.handle).catch(() => null);
    if (looksActive(state)) return true;
  }
  return false;
}

async function activateAndVerifySellMode(page) {
  const controls = await findSellControls(page);
  if (!controls.length) {
    throw new HaiHaRateError("SELL_BUTTON_NOT_FOUND", "Không tìm thấy nút 'You sell/Bạn bán' trên calculator Hai Ha.");
  }

  if (controls.some((item) => looksActive(item.state))) {
    log("SELL_MODE_VERIFIED", "already active");
    return;
  }

  let clickWorked = false;
  for (const item of controls) {
    try {
      await item.handle.click();
      clickWorked = true;
      log("SELL_CONTROL_CLICKED");
      break;
    } catch (error) {
      log("SELL_CLICK_FAILED", error?.message || "unknown click error");
    }
  }

  if (!clickWorked) {
    throw new HaiHaRateError("SELL_CLICK_FAILED", "Không thể chuyển calculator Hai Ha sang chế độ 'You sell/Bạn bán'.");
  }

  await new Promise((resolve) => setTimeout(resolve, 700));
  if (!(await verifySellMode(page))) {
    throw new HaiHaRateError(
      "SELL_MODE_NOT_VERIFIED",
      "Đã bấm 'You sell/Bạn bán' nhưng không xác minh được calculator thực sự ở chế độ bán."
    );
  }
  log("SELL_MODE_VERIFIED");
}

// Inspect visible calculator inputs and use the smallest nearby DOM context to verify
// that the sell field is USD and the receive field is AUD.
async function getDirectionalFieldSnapshot(page) {
  return page.evaluate(() => {
    function visible(el) {
      const s = window.getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return s.display !== "none" && s.visibility !== "hidden" && r.width > 0 && r.height > 0;
    }

    function contextFor(el) {
      const contexts = [];
      let node = el;
      for (let i = 0; node && i < 7; i += 1, node = node.parentElement) {
        const text = (node.innerText || node.textContent || "").replace(/\s+/g, " ").trim();
        if (text) contexts.push(text.slice(0, 800));
      }
      return contexts;
    }

    const inputs = Array.from(document.querySelectorAll("input"))
      .filter(visible)
      .map((el, index) => ({
        index,
        value: el.value || "",
        name: el.getAttribute("name") || "",
        ariaLabel: el.getAttribute("aria-label") || "",
        placeholder: el.getAttribute("placeholder") || "",
        contexts: contextFor(el),
      }));

    function score(item, kind) {
      const labelRe = kind === "sell" ? /\byou\s*sell\b|\bbạn\s*bán\b/i : /\byou\s*receive\b|\bbạn\s*nhận\b/i;
      const currencyRe = kind === "sell" ? /\bUSD\b/i : /\bAUD\b/i;
      const wrongLabelRe = kind === "sell" ? /\byou\s*receive\b|\bbạn\s*nhận\b/i : /\byou\s*sell\b|\bbạn\s*bán\b/i;
      let best = -1;
      for (let i = 0; i < item.contexts.length; i += 1) {
        const t = item.contexts[i];
        if (labelRe.test(t) && currencyRe.test(t)) {
          let v = 100 - i * 8;
          if (wrongLabelRe.test(t)) v -= 35;
          if (v > best) best = v;
        }
      }
      const attrs = `${item.name} ${item.ariaLabel} ${item.placeholder}`;
      if (labelRe.test(attrs)) best += 30;
      return best;
    }

    let sell = null;
    let receive = null;
    for (const item of inputs) {
      const s = score(item, "sell");
      const r = score(item, "receive");
      if (!sell || s > sell.score) sell = { ...item, score: s };
      if (!receive || r > receive.score) receive = { ...item, score: r };
    }

    return {
      sell: sell && sell.score > 0 ? sell : null,
      receive: receive && receive.score > 0 ? receive : null,
      visibleInputCount: inputs.length,
      headline: (document.body?.innerText || "").match(/1\s*AUD\s*=\s*[0-9.,]+\s*USD/i)?.[0] || null,
    };
  });
}

async function setVisibleInputByIndex(page, visibleIndex, value) {
  const ok = await page.evaluate(({ visibleIndex, value }) => {
    function visible(el) {
      const s = window.getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return s.display !== "none" && s.visibility !== "hidden" && r.width > 0 && r.height > 0;
    }
    const inputs = Array.from(document.querySelectorAll("input")).filter(visible);
    const el = inputs[visibleIndex];
    if (!el) return false;

    el.focus();
    const proto = Object.getPrototypeOf(el);
    const descriptor = Object.getOwnPropertyDescriptor(proto, "value") ||
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
    if (descriptor?.set) descriptor.set.call(el, String(value));
    else el.value = String(value);

    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: String(value) }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("blur", { bubbles: true }));
    return true;
  }, { visibleIndex, value });

  if (!ok) throw new HaiHaRateError("SELL_INPUT_NOT_FOUND", "Không tìm thấy ô số tiền 'You sell' của Hai Ha.");
}

async function getVerifiedUsdAudQuote(page) {
  let snapshot = await getDirectionalFieldSnapshot(page);
  if (!snapshot.sell) {
    throw new HaiHaRateError("USD_NOT_SELECTED", "Không xác minh được ô 'You sell' đang dùng USD.");
  }
  if (!snapshot.receive) {
    throw new HaiHaRateError("AUD_OUTPUT_NOT_FOUND", "Không xác minh được ô 'You receive' đang nhận AUD.");
  }

  log("USD_SELECTED", `input #${snapshot.sell.index}`);
  log("AUD_DIRECTION_VERIFIED", `output #${snapshot.receive.index}`);

  await setVisibleInputByIndex(page, snapshot.sell.index, QUOTE_USD_AMOUNT);
  log("QUOTE_AMOUNT_ENTERED", String(QUOTE_USD_AMOUNT));

  const deadline = Date.now() + ACTION_TIMEOUT_MS;
  let receivedAud = null;
  let soldUsd = null;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    snapshot = await getDirectionalFieldSnapshot(page);
    if (!snapshot.sell || !snapshot.receive) continue;

    soldUsd = parseMoneyNumber(snapshot.sell.value);
    receivedAud = parseMoneyNumber(snapshot.receive.value);

    if (soldUsd > 0 && receivedAud > 0 && Math.abs(soldUsd - QUOTE_USD_AMOUNT) < 0.01) break;
  }

  if (!(soldUsd > 0) || Math.abs(soldUsd - QUOTE_USD_AMOUNT) >= 0.01) {
    throw new HaiHaRateError("SELL_AMOUNT_NOT_CONFIRMED", "Calculator Hai Ha không xác nhận số USD thử nghiệm đã nhập.");
  }
  if (!(receivedAud > 0)) {
    throw new HaiHaRateError("AUD_OUTPUT_NOT_FOUND", "Hai Ha chưa trả về số AUD nhận được cho giao dịch SELL USD.");
  }

  const derived = deriveUsdToAudRate(soldUsd, receivedAud);
  if (!derived) {
    throw new HaiHaRateError("RATE_INVALID", "Không thể tính tỷ giá USD→AUD hợp lệ từ kết quả calculator Hai Ha.");
  }

  return {
    ...derived,
    headline: snapshot.headline,
  };
}

function classifyError(error) {
  if (error instanceof HaiHaRateError) return error;
  const message = error?.message || "Không thể đọc tỷ giá Hai Ha.";
  if (/timeout/i.test(message)) {
    return new HaiHaRateError("BROWSER_TIMEOUT", "Calculator Hai Ha phản hồi quá chậm hoặc browser bị timeout.");
  }
  return new HaiHaRateError("BROWSER_ERROR", "Không thể đọc calculator Hai Ha tự động.");
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, max-age=0, must-revalidate");
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, status: "METHOD_NOT_ALLOWED", message: "GET only" });
  }

  let browser;
  try {
    log("START");
    chromium.setGraphicsMode = false;
    browser = await puppeteer.launch({
      args: await puppeteer.defaultArgs({ args: chromium.args, headless: "shell" }),
      executablePath: await chromium.executablePath(),
      headless: "shell",
      defaultViewport: { width: 390, height: 844, deviceScaleFactor: 1 },
    });
    log("BROWSER_LAUNCHED");

    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
    page.setDefaultTimeout(ACTION_TIMEOUT_MS);

    await page.goto(CALCULATOR_URL, { waitUntil: "domcontentloaded" });
    log("PAGE_LOADED");
    await new Promise((resolve) => setTimeout(resolve, 1100));

    let text = await bodyText(page);
    if (isMaintenanceText(text)) {
      throw new HaiHaRateError("HAIHA_MAINTENANCE", "Calculator Hai Ha đang bảo trì hoặc chưa trả dữ liệu.");
    }
    log("MAINTENANCE_CHECK", "clear");

    await activateAndVerifySellMode(page);

    text = await bodyText(page);
    if (isMaintenanceText(text)) {
      throw new HaiHaRateError("HAIHA_MAINTENANCE", "Calculator Hai Ha đang bảo trì hoặc chưa trả dữ liệu.");
    }

    const quote = await getVerifiedUsdAudQuote(page);
    log("RATE_EXTRACTED", `${quote.receivedAud} AUD / ${quote.soldUsd} USD`);
    log("RATE_VALIDATED", String(quote.rate));

    return res.status(200).json({
      ok: true,
      status: "VERIFIED",
      provider: "HAI_HA",
      fromCurrency: "USD",
      toCurrency: "AUD",
      customerAction: "SELL",
      mode: "CUSTOMER_SELLS_USD",
      verified: true,
      rate: Number(quote.rate.toFixed(6)),
      soldUsd: quote.soldUsd,
      receivedAud: quote.receivedAud,
      quoteMethod: quote.quoteMethod,
      calculatorHeadline: quote.headline,
      fetchedAt: new Date().toISOString(),
      source: "Hai Ha Foreign Exchange Calculator",
      sourceUrl: CALCULATOR_URL,
    });
  } catch (rawError) {
    const error = classifyError(rawError);
    log(error.status, rawError?.message || error.message);
    return res.status(error.httpStatus || 503).json({
      ok: false,
      status: error.status,
      provider: "HAI_HA",
      fromCurrency: "USD",
      toCurrency: "AUD",
      customerAction: "SELL",
      mode: "CUSTOMER_SELLS_USD",
      verified: false,
      message: error.message,
      fetchedAt: new Date().toISOString(),
    });
  } finally {
    if (browser) {
      try {
        await browser.close();
        log("BROWSER_CLOSED");
      } catch (error) {
        log("BROWSER_CLOSE_FAILED", error?.message || "unknown close error");
      }
    }
  }
}
