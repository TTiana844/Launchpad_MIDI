// /api/evaluate.js  (Launchpad)
// Vercel Serverless Function (Node.js runtime).
// Prijme z frontendu { model, max_tokens, system, messages } a bezpečne
// zavolá Anthropic API pomocou kľúča uloženého v premennej prostredia
// ANTHROPIC_API_KEY (nastavuje sa vo Vercel dashboarde, nie v kóde).
// Kľúč sa vďaka tomu nikdy neposiela do prehliadača používateľa.
//
// Odolnosť voči orezaným odpovediam:
//  - k systémovému promptu sa pripája pokyn na stručný, platný JSON,
//  - predvolený limit výstupu je 2048 tokenov (slovenčina je "drahá" na tokeny),
//  - ak model skončí so stop_reason "max_tokens", endpoint automaticky
//    skúsi jeden retry s dvojnásobným limitom (max. MAX_TOKENS_CAP),
//  - ak je odpoveď aj potom orezaná, vráti sa s príznakom `truncated: true`,
//    aby frontend vedel spustiť lokálny fallback,
//  - krátke opakovanie pri dočasných chybách (429, 5xx, 529).

const API_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = "claude-haiku-4-5-20251001";
const DEFAULT_MAX_TOKENS = 2048;
const MAX_TOKENS_CAP = 4096;
const REQUEST_TIMEOUT_MS = 25000;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 529]);

// Pokyn pripojený k systémovému promptu z frontendu.
const CONCISE_INSTRUCTION =
  "Odpovedaj VÝHRADNE v platnom JSON formáte, bez markdown blokov (bez ```) a bez textu mimo JSON. " +
  "Všetky textové polia (ako strengths, improvements, summary) musia byť stručné " +
  "(maximálne 2 až 3 vety na pole), aby odpoveď nepresiahla limit tokenov " +
  "a JSON bol vždy kompletný a správne uzatvorený.";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clampMaxTokens(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_TOKENS;
  return Math.min(Math.floor(n), MAX_TOKENS_CAP);
}

// Jedno volanie Anthropic API s timeoutom. Vracia { ok, status, data }.
async function callAnthropic(headers, payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    let data;
    try {
      data = await response.json();
    } catch {
      data = { error: { message: "Anthropic API vrátilo odpoveď, ktorá nie je JSON." } };
    }
    return { ok: response.ok, status: response.status, data };
  } finally {
    clearTimeout(timer);
  }
}

// Volanie s jedným opakovaním pri dočasných chybách.
async function callWithRetry(headers, payload) {
  let result = await callAnthropic(headers, payload);
  if (!result.ok && RETRYABLE_STATUS.has(result.status)) {
    await sleep(800);
    result = await callAnthropic(headers, payload);
  }
  return result;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed. Use POST." });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({
      error: "Server nemá nastavený ANTHROPIC_API_KEY. Pridaj ho v Vercel → Settings → Environment Variables a znovu nasaď projekt."
    });
    return;
  }

  // req.body môže prísť ako objekt alebo ako string (podľa Content-Type).
  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      res.status(400).json({ error: "Telo požiadavky nie je platný JSON." });
      return;
    }
  }

  const { model, max_tokens, system, messages } = body || {};

  if (!Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: "Chýba pole 'messages' v tele požiadavky (musí byť neprázdne pole)." });
    return;
  }

  const headers = {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01"
  };
  // Voliteľné: ak API kľúč funguje na viacerých workspace-och (identity-linked kľúč),
  // Anthropic API vyžaduje aj túto hlavičku. Nastav ANTHROPIC_WORKSPACE_ID vo Vercel
  // Environment Variables, ak dostávaš chybu "anthropic-workspace-id is required...".
  if (process.env.ANTHROPIC_WORKSPACE_ID) {
    headers["anthropic-workspace-id"] = process.env.ANTHROPIC_WORKSPACE_ID;
  }

  const payload = {
    model: model || DEFAULT_MODEL,
    max_tokens: clampMaxTokens(max_tokens),
    system: system ? `${system}\n\n${CONCISE_INSTRUCTION}` : CONCISE_INSTRUCTION,
    messages
  };

  try {
    let result = await callWithRetry(headers, payload);

    // Odpoveď orezaná na max_tokens -> jeden retry s vyšším limitom.
    if (
      result.ok &&
      result.data?.stop_reason === "max_tokens" &&
      payload.max_tokens < MAX_TOKENS_CAP
    ) {
      const retryPayload = {
        ...payload,
        max_tokens: Math.min(payload.max_tokens * 2, MAX_TOKENS_CAP)
      };
      const retryResult = await callWithRetry(headers, retryPayload);
      if (retryResult.ok) {
        result = retryResult;
      }
    }

    if (!result.ok) {
      res.status(result.status).json({
        error: result.data?.error?.message || "Chyba pri volaní Anthropic API.",
        details: result.data
      });
      return;
    }

    // Ak je odpoveď stále orezaná, frontend to vie z tohto príznaku
    // a môže prepnúť na lokálny fallback.
    const truncated = result.data?.stop_reason === "max_tokens";
    res.status(200).json({ ...result.data, truncated });
  } catch (err) {
    const timedOut = err?.name === "AbortError";
    res.status(timedOut ? 504 : 500).json({
      error: timedOut
        ? "Anthropic API neodpovedalo včas."
        : "Nepodarilo sa spojiť s Anthropic API.",
      details: String(err)
    });
  }
}
