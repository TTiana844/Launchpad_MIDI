// /api/evaluate.js
// Vercel Serverless Function (Node.js runtime).
// 1) Overí odovzdanie (trieda, členovia) a zavolá Anthropic API kľúčom z ANTHROPIC_API_KEY.
// 2) Hodnotenie spracuje a ULOŽÍ do databázy — žiak výsledok nemá kde upraviť,
//    zapisuje len server.
// 3) Ak AI zlyhá, uloží sa odovzdanie "čaká na ručné hodnotenie" (bez známky).

import { dbConfigured, cmd, getActiveClass, PROJECT, subsKey } from "./_db.js";

const TZ = "Europe/Bratislava";
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

// Vráti { result } alebo { err } s dôvodom ("truncated" = odpoveď AI sa odrezala na
// limite max_tokens, "bad_json" = AI nevrátila platný JSON).
function parseAI(data) {
  const txt = (data.content || []).map(b => b.text || "").join("").trim();
  try {
    let s = txt.replace(/```json|```/g, "").trim();
    // AI niekedy pridá vetu pred/za JSON — vezmeme len objekt od prvej { po poslednú }
    const a = s.indexOf("{"), b = s.lastIndexOf("}");
    if (a >= 0 && b > a) s = s.slice(a, b + 1);
    const p = JSON.parse(s);
    return {
      result: {
        grade: Math.max(1, Math.min(5, parseInt(p.grade) || 3)),
        total: Math.max(0, Math.min(100, parseInt(p.total) || 0)),
        criteria: (p.criteria && typeof p.criteria === "object") ? p.criteria : {},
        strengths: String(p.strengths || "Práca odovzdaná."),
        improvements: String(p.improvements || "Doplň komentár."),
        summary: String(p.summary || "Automatické hodnotenie.")
      }
    };
  } catch {
    return { err: data.stop_reason === "max_tokens" ? "truncated (max_tokens)" : "bad_json" };
  }
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

  const { model, max_tokens, system, messages, meta } = req.body || {};
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

    const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: model || "claude-haiku-4-5-20251001",
        max_tokens: max_tokens || 600,
        system: system || undefined,
        messages
      })
    });

    const data = await anthropicRes.json();

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

    const parsed = parseAI(data);
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
