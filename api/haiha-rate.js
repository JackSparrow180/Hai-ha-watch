const HAIHA_SELL_USD_ENDPOINT = "https://fefx-api.fefx.com.au/api/swift/rate/sell/USD";
const FETCH_TIMEOUT_MS = 8000;

class HaiHaRateError extends Error {
  constructor(status, message, httpStatus = 503, diagnostic = null) {
    super(message);
    this.name = "HaiHaRateError";
    this.status = status;
    this.httpStatus = httpStatus;
    this.diagnostic = diagnostic;
  }
}

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, max-age=0, must-revalidate");
  res.end(JSON.stringify(body));
}

function isFinitePositiveNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0;
}

function validateRawSellRate(rawRate) {
  // Hai Ha's public SELL/USD endpoint returns foreign-currency units per 1 AUD.
  // For USD this should be a plausible AUD->USD quote, not the USD->AUD display
  // value used by our app. Keep a broad sanity bound so obviously broken data
  // (0, null, HTML, etc.) is rejected without pretending this is direction proof.
  return isFinitePositiveNumber(rawRate) && Number(rawRate) > 0.2 && Number(rawRate) < 2;
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return json(res, 405, {
      ok: false,
      status: "METHOD_NOT_ALLOWED",
      message: "Chỉ hỗ trợ GET."
    });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const fetchedAt = new Date().toISOString();

  try {
    const upstream = await fetch(HAIHA_SELL_USD_ENDPOINT, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Origin: "https://www.hhmt.com.au",
        Referer: "https://www.hhmt.com.au/foreign-exchange?type=you-sell",
        "User-Agent": "HaiHa-USD-Watch/2.5"
      },
      cache: "no-store",
      signal: controller.signal
    });

    if (!upstream.ok) {
      throw new HaiHaRateError(
        "HAIHA_UPSTREAM_HTTP_ERROR",
        `Nguồn tỷ giá Hai Ha trả HTTP ${upstream.status}.`,
        503,
        { upstreamStatus: upstream.status }
      );
    }

    let payload;
    try {
      payload = await upstream.json();
    } catch {
      throw new HaiHaRateError(
        "HAIHA_INVALID_JSON",
        "Nguồn tỷ giá Hai Ha không trả dữ liệu JSON hợp lệ."
      );
    }

    const currencyCode = String(payload?.currencyCode || "").toUpperCase();
    const rawRate = Number(payload?.rate);

    if (currencyCode !== "USD") {
      throw new HaiHaRateError(
        "HAIHA_WRONG_CURRENCY",
        "Nguồn Hai Ha không trả USD như mong đợi.",
        503,
        { currencyCode }
      );
    }

    if (!validateRawSellRate(rawRate)) {
      throw new HaiHaRateError(
        "HAIHA_INVALID_RATE",
        "Hai Ha trả tỷ giá USD không hợp lệ.",
        503,
        { rawRate: Number.isFinite(rawRate) ? rawRate : null }
      );
    }

    // Hai Ha public endpoint path is /rate/sell/USD and the live calculator
    // presents this quote as 1 AUD = rawRate USD. For a customer selling USD
    // and receiving AUD, the normalized app rate is therefore 1 / rawRate:
    // 1 USD = (1/rawRate) AUD.
    const normalizedUsdToAud = 1 / rawRate;

    // Extra sanity bound for the normalized USD -> AUD result.
    if (!(normalizedUsdToAud > 0.5 && normalizedUsdToAud < 3)) {
      throw new HaiHaRateError(
        "HAIHA_NORMALIZED_RATE_INVALID",
        "Tỷ giá USD → AUD sau khi chuẩn hóa không hợp lệ.",
        503,
        { rawRate }
      );
    }

    return json(res, 200, {
      ok: true,
      provider: "HAI_HA",
      fromCurrency: "USD",
      toCurrency: "AUD",
      customerAction: "SELL",
      mode: "CUSTOMER_SELLS_USD",
      verified: true,
      rate: Number(normalizedUsdToAud.toFixed(8)),
      rawHaiHaRate: rawRate,
      rawHaiHaConvention: "1_AUD_EQUALS_X_USD",
      quoteMethod: "HAIHA_SELL_USD_RATE_RECIPROCAL",
      source: "Hai Ha public FX sell/USD endpoint",
      sourceEndpoint: HAIHA_SELL_USD_ENDPOINT,
      fetchedAt
    });
  } catch (error) {
    const isAbort = error?.name === "AbortError";
    const known = error instanceof HaiHaRateError;
    return json(res, known ? error.httpStatus : 503, {
      ok: false,
      status: known ? error.status : (isAbort ? "HAIHA_TIMEOUT" : "HAIHA_FETCH_ERROR"),
      provider: "HAI_HA",
      fromCurrency: "USD",
      toCurrency: "AUD",
      customerAction: "SELL",
      mode: "CUSTOMER_SELLS_USD",
      verified: false,
      message: known
        ? error.message
        : (isAbort ? "Nguồn Hai Ha phản hồi quá chậm." : "Không thể lấy tỷ giá Hai Ha tự động."),
      diagnostic: known ? error.diagnostic : null,
      fetchedAt
    });
  } finally {
    clearTimeout(timer);
  }
}
