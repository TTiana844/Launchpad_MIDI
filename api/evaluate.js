// /api/evaluate.js
// Vercel Serverless Function (Node.js runtime).
// 1) Overí odovzdanie (trieda, členovia) a zavolá Anthropic API kľúčom z ANTHROPIC_API_KEY.
// 2) Hodnotenie spracuje a ULOŽÍ do databázy — žiak výsledok nemá kde upraviť,
//    zapisuje len server.
// 3) Ak AI zlyhá, uloží sa odovzdanie "čaká na ručné hodnotenie" (bez známky).

import { dbConfigured, cmd, getActiveClass, PROJECT, subsKey } from "./_db.js";

const TZ = "Europe/Bratislava";
const MIN_TOKENS = 2500;      // minimum max_tokens pre hodnotenie
const RETRY_TOKENS = 4000;    // pri opakovaní po odrezanej/nečitateľnej odpovedi
const EX_IDS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"];

function stamp() {
  const d = new Date();
  return {
    ts: d.getTime(),
    time: d.toLocaleTimeString("sk-SK", { timeZone: TZ, hour: "2-digit", minute: "2-digit" }),
    date: d.toLocaleDateString("sk-SK", { timeZone: TZ })
  };
}

// Overí meta (trieda, cvičenie, členovia). Vracia { v } alebo { error, status }.
async function resolveMeta(meta) {
  if (!meta || typeof meta !== "object") return { error: "Chýbajú údaje o odovzdaní.", status: 400 };
  const exId = String(meta.exId);
  if (!EX_IDS.includes(exId)) return { error: "Neznáme cvičenie.", status: 400 };

  const cls = await getActiveClass();
  if (!cls) return { error: "Učiteľ zatiaľ nenastavil aktívnu triedu.", status: 409 };
  if (String(meta.classId) !== cls.id) {
    return { error: "Trieda sa medzitým zmenila. Obnov stránku (F5) a vyber sa znova.", status: 409 };
  }

  const ids = Array.isArray(meta.members) ? [...new Set(meta.members.map(String))] : [];
  if (ids.length < 1 || ids.length > 4) return { error: "Tím môže mať 1 až 4 členov.", status: 400 };
  const byId = Object.fromEntries(cls.students.filter(s => s.name).map(s => [s.id, s]));
  if (!ids.every(id => byId[id])) return { error: "Niektorý člen nie je v zozname triedy.", status: 400 };

  // Odkaz na súbory na Google Drive je povinný (https://drive.google.com/…, docs.google.com/…)
  const link = typeof meta.link === "string" ? meta.link.trim().slice(0, 300) : "";
  if (!/^https:\/\/([a-z0-9-]+\.)*google\.com\//i.test(link)) {
    return { error: "Vlož odkaz na svoje súbory na Google Drive (začína https://drive.google.com/…).", status: 400 };
  }

  // Roly členov tímu (voliteľné, napr. "bubeník") — len pre členov tímu, krátke texty
  const roles = {};
  if (meta.roles && typeof meta.roles === "object") {
    for (const id of ids) {
      const r = meta.roles[id];
      if (typeof r === "string" && r.trim()) roles[id] = r.trim().slice(0, 30);
    }
  }

  return {
    v: {
      cls,
      exId,
      roles,
      members: ids.sort(),
      ckN: Number(meta.ckN) || 0,
      ckT: Number(meta.ckT) || 0,
      fc: Number(meta.fc) || 0,
      comm: String(meta.comm ?? "").slice(0, 1200),
      link
    }
  };
}

async function saveAttempt(v, result, err) {
  const attempt = {
    ...stamp(),
    ckN: v.ckN, ckT: v.ckT, fc: v.fc, comm: v.comm, link: v.link,
    ...(err ? { err: String(err).slice(0, 160) } : {}),
    ...(Object.keys(v.roles).length ? { roles: v.roles } : {}),
    pending: !result,
    ...(result || {})
  };
  const hash = subsKey(v.cls.id);
  await cmd("SADD", "projects", PROJECT);
  const key = `${v.exId}|${v.members.join("+")}`;
  const cur = await cmd("HGET", hash, key);
  const rec = cur ? JSON.parse(cur) : { exId: v.exId, members: v.members, attempts: [] };
  rec.attempts.push(attempt);
  if (rec.attempts.length > 10) rec.attempts = rec.attempts.slice(-10);
  await cmd("HSET", hash, key, JSON.stringify(rec));
  return attempt;
}

// Nástroj, ktorým AI vracia hodnotenie. Pri vynútenom tool_choice vráti API hotový
// objekt (nie text), takže odpadá chyba "bad_json" (nezakončené/neescapované úvodzovky).
// Kritériá sa líšia podľa cvičenia (kľúče a maximá posiela appka v poli "criteria"),
// preto sa schéma skladá dynamicky; ak ich appka nepošle, použije sa všeobecná schéma.
function sanitizeCriteria(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const c of list.slice(0, 12)) {
    const k = c && typeof c.k === "string" ? c.k : "";
    const m = Math.round(Number(c && c.m));
    if (!/^[a-zA-Z0-9_-]{1,20}$/.test(k) || !(m >= 1 && m <= 100)) return null;
    out.push({ k, m });
  }
  return out.length ? out : null;
}

function buildEvalTool(criteriaSpec) {
  const spec = sanitizeCriteria(criteriaSpec);
  const criteria = spec
    ? {
        type: "object",
        properties: Object.fromEntries(spec.map(c => [c.k, { type: "integer", minimum: 0, maximum: c.m }])),
        required: spec.map(c => c.k)
      }
    : { type: "object", additionalProperties: { type: "integer", minimum: 0, maximum: 100 } };
  return {
    name: "submit_evaluation",
    description: "Odošle hotové hodnotenie žiackeho odovzdania.",
    input_schema: {
      type: "object",
      properties: {
        grade: { type: "integer", minimum: 1, maximum: 5, description: "Známka 1 (výborný) až 5 (nedostatočný)" },
        total: { type: "integer", minimum: 0, maximum: 100, description: "Celkové skóre v percentách" },
        criteria,
        strengths: { type: "string", description: "Silné stránky, stručne (max. cca 80 slov)" },
        improvements: { type: "string", description: "Odporúčania na zlepšenie, stručne (max. cca 100 slov)" },
        summary: { type: "string", description: "Celkové zhrnutie, 2–3 vety" }
      },
      required: ["grade", "total", "criteria", "strengths", "improvements", "summary"]
    }
  };
}

function normalize(p) {
  return {
    grade: Math.max(1, Math.min(5, parseInt(p.grade) || 3)),
    total: Math.max(0, Math.min(100, parseInt(p.total) || 0)),
    criteria: (p.criteria && typeof p.criteria === "object")
      ? Object.fromEntries(Object.entries(p.criteria).map(([k, v]) => [k, Math.max(0, parseInt(v) || 0)]))
      : {},
    strengths: String(p.strengths || "Práca odovzdaná."),
    improvements: String(p.improvements || "Doplň komentár."),
    summary: String(p.summary || "Automatické hodnotenie.")
  };
}

// Vráti { result } alebo { err } s dôvodom ("truncated" = odpoveď AI sa odrezala na
// limite max_tokens, "bad_json" = AI nevrátila platný JSON, "no_output" = prázdna odpoveď).
function parseAI(data) {
  const blocks = Array.isArray(data.content) ? data.content : [];

  // 1) Preferovaná cesta: tool_use (hotový objekt)
  const tool = blocks.find(b => b && b.type === "tool_use" && b.input && typeof b.input === "object");
  if (tool && data.stop_reason !== "max_tokens") {
    return { result: normalize(tool.input) };
  }
  if (data.stop_reason === "max_tokens") return { err: "truncated (max_tokens)" };

  // 2) Záloha: text s JSON-om
  const txt = blocks.map(b => b.text || "").join("").trim();
  if (!txt) return { err: "no_output" };
  try {
    let t = txt.replace(/```json|```/g, "").trim();
    const a = t.indexOf("{"), b = t.lastIndexOf("}");
    if (a >= 0 && b > a) t = t.slice(a, b + 1);
    return { result: normalize(JSON.parse(t)) };
  } catch {
    return { err: "bad_json" };
  }
}

// Zavolá Anthropic API. Vracia { res, data } (res = fetch odpoveď).
async function callAnthropic(headers, { model, max_tokens, system, messages, tool }) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: model || "claude-haiku-4-5-20251001",
      // Dolná hranica: slovenčina je „drahá“ na tokeny a odpoveď má ~6 polí textu
      max_tokens: Math.max(Number(max_tokens) || 0, MIN_TOKENS),
      system: system || undefined,
      messages,
      tools: [tool],
      tool_choice: { type: "tool", name: tool.name }
    })
  });
  const data = await res.json().catch(() => ({}));
  return { res, data };
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

  const { model, max_tokens, system, messages, meta, criteria } = req.body || {};
  if (!messages) {
    res.status(400).json({ error: "Chýba pole 'messages' v tele požiadavky." });
    return;
  }

  const useDb = dbConfigured();
  let v = null;
  if (useDb) {
    try {
      const m = await resolveMeta(meta);
      if (m.error) {
        res.status(m.status).json({ error: m.error });
        return;
      }
      v = m.v;
    } catch (e) {
      res.status(500).json({ error: "Databáza nie je dostupná.", details: String(e.message || e) });
      return;
    }
  }

  // Zaznamená odovzdanie bez známky, aby ho učiteľ videl aj keď AI zlyhala.
  const savePending = async (reason) => {
    if (!v) return false;
    try { await saveAttempt(v, null, reason); return true; } catch { return false; }
  };

  try {
    const headers = {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    };
    // Voliteľné: ak API kľúč funguje na viacerých workspace-och (identity-linked kľúč),
    // Anthropic API vyžaduje aj túto hlavičku (ANTHROPIC_WORKSPACE_ID vo Vercel Environment Variables).
    if (process.env.ANTHROPIC_WORKSPACE_ID) {
      headers["anthropic-workspace-id"] = process.env.ANTHROPIC_WORKSPACE_ID;
    }

    const tool = buildEvalTool(criteria);
    let { res: anthropicRes, data } = await callAnthropic(headers, { model, max_tokens, system, messages, tool });

    // Dočasné preťaženie / chyba servera Anthropicu (429, 5xx, 529) — jedno opakovanie
    if (!anthropicRes.ok && [429, 500, 502, 503, 529].includes(anthropicRes.status)) {
      await new Promise(r => setTimeout(r, 1500));
      ({ res: anthropicRes, data } = await callAnthropic(headers, { model, max_tokens, system, messages, tool }));
    }

    if (!anthropicRes.ok) {
      const msg = data?.error?.message || "Chyba pri volaní Anthropic API.";
      const savedPending = await savePending(`api ${anthropicRes.status}: ${msg}`);
      res.status(anthropicRes.status).json({
        error: msg,
        details: data,
        savedPending
      });
      return;
    }

    let parsed = parseAI(data);
    // Odrezaná alebo nečitateľná odpoveď — jedno opakovanie s väčším limitom
    if (!parsed.result) {
      const again = await callAnthropic(headers, { model, max_tokens: RETRY_TOKENS, system, messages, tool });
      if (again.res.ok) parsed = parseAI(again.data);
      if (parsed.result) data = again.data;
    }
    const result = parsed.result;
    if (!result) {
      const savedPending = await savePending(parsed.err);
      res.status(502).json({ error: "Odpoveď AI sa nedala spracovať.", reason: parsed.err, savedPending });
      return;
    }

    if (!v) {
      // Databáza nie je nastavená — hodnotenie sa vráti, ale neuloží
      res.status(200).json({ ...data, saved: false, reason: "no_db", record: result });
      return;
    }

    let attempt;
    try {
      attempt = await saveAttempt(v, result);
    } catch (e) {
      res.status(200).json({ ...data, saved: false, reason: "db_error", record: result });
      return;
    }
    res.status(200).json({ ...data, saved: true, record: attempt });
  } catch (err) {
    const savedPending = await savePending("network: " + String(err).slice(0, 100));
    res.status(500).json({ error: "Nepodarilo sa spojiť s Anthropic API.", details: String(err), savedPending });
  }
}
