export function normalizeText(text = "") {
  return String(text).replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

export function isMaintenanceText(text = "") {
  const t = normalizeText(text);
  return /under maintenance|maintenance|bảo trì|bao tri|try later/i.test(t);
}

export function isRateSane(rate) {
  return typeof rate === "number" && Number.isFinite(rate) && rate > 0.5 && rate < 3;
}

// Parse a value displayed by the calculator, e.g. "2,051.70" or "2051.70".
export function parseMoneyNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  let s = String(value ?? "").trim().replace(/[^0-9,.-]/g, "");
  if (!s) return null;

  const comma = s.lastIndexOf(",");
  const dot = s.lastIndexOf(".");

  if (comma >= 0 && dot >= 0) {
    // Whichever separator appears last is treated as the decimal separator.
    if (dot > comma) s = s.replace(/,/g, "");
    else s = s.replace(/\./g, "").replace(",", ".");
  } else if (comma >= 0) {
    const parts = s.split(",");
    // A single comma followed by 1-2 digits is probably decimal; otherwise thousands.
    if (parts.length === 2 && parts[1].length <= 2) s = parts[0] + "." + parts[1];
    else s = s.replace(/,/g, "");
  }

  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function deriveUsdToAudRate(soldUsd, receivedAud) {
  const sold = parseMoneyNumber(soldUsd);
  const received = parseMoneyNumber(receivedAud);
  if (!(sold > 0) || !(received > 0)) return null;

  const rate = received / sold;
  if (!isRateSane(rate)) return null;

  return {
    rate,
    soldUsd: sold,
    receivedAud: received,
    fromCurrency: "USD",
    toCurrency: "AUD",
    quoteMethod: "SELL_OUTPUT_DIVIDED_BY_INPUT",
  };
}

// Kept only for diagnostics / backward tests. It is NOT the primary live-rate method.
export function parseDirectUsdToAud(text = "") {
  const normalized = normalizeText(text);
  const match = normalized.match(/1\s*USD\s*=\s*([0-9]+(?:[.,][0-9]+)?)\s*AUD/i);
  if (!match) return null;

  const rate = Number(match[1].replace(",", "."));
  if (!isRateSane(rate)) return null;

  return {
    rate,
    quote: match[0],
    fromCurrency: "USD",
    toCurrency: "AUD",
  };
}
