import puppeteer from "puppeteer-core";
import chromium from "@sparticuz/chromium";
import {
  deriveUsdToAudRate,
  isMaintenanceText,
  parseMoneyNumber,
} from "../lib/haiha-parser.js";

const CALCULATOR_URLS = [
  "https://app.hhmt.com.au/fx-calculator-form?type=you-sell&lang=en",
  "https://app.hhmt.com.au/fx-calculator-form?lang=en&type=you-sell",
  "https://app.hhmt.com.au/fx-calculator-form?lang=en",
];
const NAVIGATION_TIMEOUT_MS = 18000;
const ACTION_TIMEOUT_MS = 8000;
const RENDER_TIMEOUT_MS = 9000;
const QUOTE_USD_AMOUNT = 1500;

class HaiHaRateError extends Error {
  constructor(status, message, httpStatus = 503, diagnostic = null) {
    super(message);
    this.name = "HaiHaRateError";
    this.status = status;
    this.httpStatus = httpStatus;
    this.diagnostic = diagnostic;
  }
}

function log(step, detail = "") {
  const suffix = detail ? ` · ${detail}` : "";
  console.log(`[HaiHa] ${step}${suffix}`);
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function pageDiagnostic(page) {
  try {
    return await page.evaluate(() => {
      const norm = (v) => String(v || "").replace(/\s+/g, " ").trim();
      return {
        title: document.title || "",
        url: location.href,
        bodyPreview: norm(document.body?.innerText || "").slice(0, 500),
        inputCount: document.querySelectorAll("input").length,
        buttonCount: document.querySelectorAll("button").length,
      };
    });
  } catch {
    return { title: "", url: page.url(), bodyPreview: "", inputCount: 0, buttonCount: 0 };
  }
}

async function bodyText(page) {
  return page.evaluate(() => document.body?.innerText || "");
}

async function waitForCalculatorRender(page) {
  const deadline = Date.now() + RENDER_TIMEOUT_MS;
  let last = null;

  while (Date.now() < deadline) {
    last = await pageDiagnostic(page);
    const body = last.bodyPreview.toLowerCase();

    if (
      body.includes("you sell") ||
      body.includes("you buy") ||
      body.includes("you receive") ||
      body.includes("bạn bán") ||
      body.includes("bạn mua") ||
      body.includes("bạn nhận") ||
      body.includes("under maintenance")
    ) {
      return last;
    }

    await sleep(400);
  }

  const diagnostic = last || (await pageDiagnostic(page));
  throw new HaiHaRateError(
    "CALCULATOR_NOT_RENDERED",
    "Trang calculator Hai Ha đã mở nhưng giao diện JavaScript chưa render trên Vercel.",
    503,
    diagnostic
  );
}

async function getSellModeSnapshot(page) {
  return page.evaluate(() => {
    const norm = (v) => String(v || "").replace(/\s+/g, " ").trim();
    const visible = (el) => {
      const s = window.getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return s.display !== "none" && s.visibility !== "hidden" && r.width > 0 && r.height > 0;
    };
    const exactSell = /^(you sell|bạn bán|ban ban)$/i;

    const all = Array.from(document.querySelectorAll("body *")).filter(visible);
    const candidates = [];
    for (const el of all) {
      const ownText = norm(
        Array.from(el.childNodes || [])
          .filter((n) => n.nodeType === Node.TEXT_NODE)
          .map((n) => n.textContent)
          .join(" ")
      );
      const fullText = norm(el.textContent);
      const aria = norm(el.getAttribute?.("aria-label"));
      const text = ownText || aria || fullText;
      if (!exactSell.test(text)) continue;

      const target =
        el.closest?.("button,[role='button'],[role='tab'],label,a,[tabindex],input[type='radio']") || el;
      const tr = target.getBoundingClientRect();
      candidates.push({
        text,
        tag: target.tagName,
        role: target.getAttribute?.("role") || "",
        className: typeof target.className === "string" ? target.className.slice(0, 300) : "",
        ariaSelected: target.getAttribute?.("aria-selected") || "",
        ariaPressed: target.getAttribute?.("aria-pressed") || "",
        ariaChecked: target.getAttribute?.("aria-checked") || "",
        x: tr.left + tr.width / 2,
        y: tr.top + tr.height / 2,
        width: tr.width,
        height: tr.height,
      });
    }

    const body = norm(document.body?.innerText || "");
    const formLooksSell =
      (/\byou sell\b/i.test(body) || /\bbạn bán\b/i.test(body)) &&
      (/\byou receive\b/i.test(body) || /\bbạn nhận\b/i.test(body));

    return {
      candidates: candidates.slice(0, 12),
      formLooksSell,
      bodyPreview: body.slice(0, 500),
    };
  });
}

async function ensureSellMode(page) {
  let snapshot = await getSellModeSnapshot(page);

  // Preferred path: the URL already requested type=you-sell and the rendered
  // form itself confirms You sell + You receive.
  if (snapshot.formLooksSell) {
    log("SELL_MODE_VERIFIED", "sell form already visible from direct URL");
    return;
  }

  // Fallback for Hai Ha versions that ignore the query parameter.
  if (!snapshot.candidates.length) {
    const diagnostic = await pageDiagnostic(page);
    throw new HaiHaRateError(
      "SELL_BUTTON_NOT_FOUND",
      "Calculator đã render nhưng không tìm thấy điều khiển 'You sell/Bạn bán'.",
      503,
      diagnostic
    );
  }

  let clicked = false;
  for (const candidate of snapshot.candidates) {
    try {
      await page.mouse.click(candidate.x, candidate.y);
      clicked = true;
      log("SELL_CONTROL_CLICKED", `${candidate.tag} ${candidate.role || ""} ${candidate.text}`);
      break;
    } catch (error) {
      log("SELL_CLICK_FAILED", error?.message || "unknown click error");
    }
  }

  if (!clicked) {
    throw new HaiHaRateError(
      "SELL_CLICK_FAILED",
      "Không thể bấm chế độ 'You sell/Bạn bán' trên calculator Hai Ha.",
      503,
      await pageDiagnostic(page)
    );
  }

  const deadline = Date.now() + ACTION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(250);
    snapshot = await getSellModeSnapshot(page);
    if (snapshot.formLooksSell) {
      log("SELL_MODE_VERIFIED", "sell form labels visible after click");
      return;
    }
  }

  throw new HaiHaRateError(
    "SELL_MODE_NOT_VERIFIED",
    "Đã bấm 'You sell/Bạn bán' nhưng calculator chưa hiển thị form bán ngoại tệ.",
    503,
    await pageDiagnostic(page)
  );
}

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
    const descriptor =
      Object.getOwnPropertyDescriptor(proto, "value") ||
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
    if (descriptor?.set) descriptor.set.call(el, String(value));
    else el.value = String(value);

    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: String(value) }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("blur", { bubbles: true }));
    return true;
  }, { visibleIndex, value });

  if (!ok) {
    throw new HaiHaRateError("SELL_INPUT_NOT_FOUND", "Không tìm thấy ô số tiền 'You sell' của Hai Ha.");
  }
}

async function getVerifiedUsdAudQuote(page) {
  let snapshot = await getDirectionalFieldSnapshot(page);
  if (!snapshot.sell) {
    throw new HaiHaRateError(
      "USD_NOT_SELECTED",
      "Không xác minh được ô 'You sell' đang dùng USD.",
      503,
      await pageDiagnostic(page)
    );
  }
  if (!snapshot.receive) {
    throw new HaiHaRateError(
      "AUD_OUTPUT_NOT_FOUND",
      "Không xác minh được ô 'You receive' đang nhận AUD.",
      503,
      await pageDiagnostic(page)
    );
  }

  log("USD_SELECTED", `input #${snapshot.sell.index}`);
  log("AUD_DIRECTION_VERIFIED", `output #${snapshot.receive.index}`);

  await setVisibleInputByIndex(page, snapshot.sell.index, QUOTE_USD_AMOUNT);
  log("QUOTE_AMOUNT_ENTERED", String(QUOTE_USD_AMOUNT));

  const deadline = Date.now() + ACTION_TIMEOUT_MS;
  let receivedAud = null;
  let soldUsd = null;
  while (Date.now() < deadline) {
    await sleep(300);
    snapshot = await getDirectionalFieldSnapshot(page);
    if (!snapshot.sell || !snapshot.receive) continue;

    soldUsd = parseMoneyNumber(snapshot.sell.value);
    receivedAud = parseMoneyNumber(snapshot.receive.value);

    if (soldUsd > 0 && receivedAud > 0 && Math.abs(soldUsd - QUOTE_USD_AMOUNT) < 0.01) break;
  }

  if (!(soldUsd > 0) || Math.abs(soldUsd - QUOTE_USD_AMOUNT) >= 0.01) {
    throw new HaiHaRateError(
      "SELL_AMOUNT_NOT_CONFIRMED",
      "Calculator Hai Ha không xác nhận số USD thử nghiệm đã nhập.",
      503,
      await pageDiagnostic(page)
    );
  }
  if (!(receivedAud > 0)) {
    throw new HaiHaRateError(
      "AUD_OUTPUT_NOT_FOUND",
      "Hai Ha chưa trả về số AUD nhận được cho giao dịch SELL USD.",
      503,
      await pageDiagnostic(page)
    );
  }

  const derived = deriveUsdToAudRate(soldUsd, receivedAud);
  if (!derived) {
    throw new HaiHaRateError(
      "RATE_INVALID",
      "Không thể tính tỷ giá USD→AUD hợp lệ từ kết quả calculator Hai Ha.",
      503,
      await pageDiagnostic(page)
    );
  }

  return { ...derived, headline: snapshot.headline };
}

function classifyError(error) {
  if (error instanceof HaiHaRateError) return error;
  const message = error?.message || "Không thể đọc tỷ giá Hai Ha.";
  if (/timeout/i.test(message)) {
    return new HaiHaRateError("BROWSER_TIMEOUT", "Calculator Hai Ha phản hồi quá chậm hoặc browser bị timeout.");
  }
  return new HaiHaRateError("BROWSER_ERROR", "Không thể đọc calculator Hai Ha tự động.");
}

async function openCalculator(page) {
  let lastError = null;
  for (const url of CALCULATOR_URLS) {
    try {
      log("NAVIGATE", url);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS });
      const rendered = await waitForCalculatorRender(page);
      log("PAGE_RENDERED", rendered.url);
      return url;
    } catch (error) {
      lastError = error;
      log("NAVIGATION_ATTEMPT_FAILED", `${url} · ${error?.status || error?.message || "unknown"}`);
      if (error instanceof HaiHaRateError && error.status === "HAIHA_MAINTENANCE") throw error;
    }
  }
  throw lastError || new HaiHaRateError("CALCULATOR_NOT_RENDERED", "Không thể render calculator Hai Ha.");
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, max-age=0, must-revalidate");
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, status: "METHOD_NOT_ALLOWED", message: "GET only" });
  }

  let browser;
  let page;
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

    page = await browser.newPage();
    page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
    page.setDefaultTimeout(ACTION_TIMEOUT_MS);

    page.on("console", (msg) => {
      if (["error", "warning"].includes(msg.type())) log("PAGE_CONSOLE", `${msg.type()}: ${msg.text().slice(0, 240)}`);
    });
    page.on("requestfailed", (request) => {
      log("REQUEST_FAILED", `${request.url().slice(0, 180)} · ${request.failure()?.errorText || "failed"}`);
    });

    const requestedUrl = await openCalculator(page);

    let text = await bodyText(page);
    if (isMaintenanceText(text)) {
      throw new HaiHaRateError(
        "HAIHA_MAINTENANCE",
        "Calculator Hai Ha đang bảo trì hoặc chưa trả dữ liệu.",
        503,
        await pageDiagnostic(page)
      );
    }
    log("MAINTENANCE_CHECK", "clear");

    await ensureSellMode(page);

    text = await bodyText(page);
    if (isMaintenanceText(text)) {
      throw new HaiHaRateError(
        "HAIHA_MAINTENANCE",
        "Calculator Hai Ha đang bảo trì hoặc chưa trả dữ liệu.",
        503,
        await pageDiagnostic(page)
      );
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
      sourceUrl: requestedUrl,
    });
  } catch (rawError) {
    const error = classifyError(rawError);
    log(error.status, rawError?.message || error.message);
    const diagnostic = error.diagnostic || (page ? await pageDiagnostic(page) : null);
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
      diagnostic,
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
