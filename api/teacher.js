// /api/teacher.js
// Chránené heslom TEACHER_PASSWORD (Vercel → Environment Variables).
// Jedna funkcia, viac akcií: { action, password, ... }

import { createHash, timingSafeEqual } from "node:crypto";
import { dbConfigured, cmd, hgetall, getJSON, setJSON, PROJECT, subsKey, ovrKey } from "./_db.js";

const EX_IDS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"];
const MAX_STUDENTS = 40;

const sha = s => createHash("sha256").update(String(s)).digest();
const passwordOk = (given, real) => timingSafeEqual(sha(given), sha(real));
const okClassId = id => typeof id === "string" && /^[a-z0-9-]{3,40}$/.test(id);

function parseValues(h) {
  const out = {};
  for (const [k, v] of Object.entries(h)) {
    try { out[k] = JSON.parse(v); } catch { /* preskočiť poškodený záznam */ }
  }
  return out;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed. Use POST." });
    return;
  }
  const real = process.env.TEACHER_PASSWORD;
  if (!real) {
    res.status(500).json({ error: "Server nemá nastavený TEACHER_PASSWORD (Vercel → Settings → Environment Variables)." });
    return;
  }
  if (!dbConfigured()) {
    res.status(500).json({ error: "Server nemá pripojenú databázu (Upstash Redis)." });
    return;
  }

  const body = req.body || {};
  if (!body.password || !passwordOk(body.password, real)) {
    await new Promise(r => setTimeout(r, 600)); // spomalí hádanie hesla
    res.status(401).json({ error: "Nesprávne heslo." });
    return;
  }

  try {
    switch (body.action) {
      case "check":
        res.status(200).json({ ok: true });
        return;

      case "overview": {
        await cmd("SADD", "projects", PROJECT);
        const projects = ((await cmd("SMEMBERS", "projects")) || []).sort();
        const ids = (await cmd("SMEMBERS", "classes")) || [];
        const classes = [];
        for (const id of ids) {
          const c = await getJSON(`class:${id}`);
          if (c) classes.push({ id: c.id, name: c.name, count: c.students.filter(s => s.name).length, createdAt: c.createdAt });
        }
        classes.sort((a, b) => b.createdAt - a.createdAt);
        const activeId = await cmd("GET", "cfg:active");
        const wanted = okClassId(body.classId) ? body.classId : (activeId || classes[0]?.id);
        if (!wanted) {
          res.status(200).json({ project: PROJECT, projects, classes: [], activeId: null, cls: null, subs: [], ovr: {} });
          return;
        }
        const cls = await getJSON(`class:${wanted}`);
        if (!cls) {
          res.status(404).json({ error: "Trieda neexistuje." });
          return;
        }
        const subs = Object.entries(parseValues(await hgetall(subsKey(wanted)))).map(([key, rec]) => ({ key, ...rec }));
        const ovr = parseValues(await hgetall(ovrKey(wanted)));
        res.status(200).json({ project: PROJECT, projects, classes, activeId, cls, subs, ovr });
        return;
      }

      case "saveClass": {
        const name = String(body.name || "").trim().slice(0, 60);
        if (!name) { res.status(400).json({ error: "Zadaj názov triedy (napr. 4.A 2026/27)." }); return; }
        let lines = Array.isArray(body.lines) ? body.lines.map(l => String(l).trim().slice(0, 80)) : [];
        while (lines.length && !lines[lines.length - 1]) lines.pop(); // prázdne riadky na konci preč
        if (!lines.length) { res.status(400).json({ error: "Zoznam žiakov je prázdny." }); return; }
        if (lines.length > MAX_STUDENTS) { res.status(400).json({ error: `Maximálne ${MAX_STUDENTS} žiakov.` }); return; }

        // Miesto v zozname = stabilné ID (s01, s02 …). Prázdny riadok = neobsadené miesto.
        const students = lines.map((n, i) => ({ id: "s" + String(i + 1).padStart(2, "0"), name: n }));

        let id = body.id;
        let createdAt = Date.now();
        if (id) {
          if (!okClassId(id)) { res.status(400).json({ error: "Neplatné id triedy." }); return; }
          const old = await getJSON(`class:${id}`);
          if (!old) { res.status(404).json({ error: "Trieda neexistuje." }); return; }
          createdAt = old.createdAt;
        } else {
          id = "c" + Date.now().toString(36);
        }
        await setJSON(`class:${id}`, { id, name, students, createdAt });
        await cmd("SADD", "classes", id);
        if (!body.id && body.setActive !== false) await cmd("SET", "cfg:active", id);
        res.status(200).json({ ok: true, id });
        return;
      }

      case "setActive": {
        if (!okClassId(body.classId) || !(await getJSON(`class:${body.classId}`))) {
          res.status(404).json({ error: "Trieda neexistuje." }); return;
        }
        await cmd("SET", "cfg:active", body.classId);
        res.status(200).json({ ok: true });
        return;
      }

      case "deleteClass": {
        if (!okClassId(body.classId)) { res.status(400).json({ error: "Neplatné id triedy." }); return; }
        // Zmaže triedu a jej odovzdania/ručné známky vo VŠETKÝCH projektoch zdieľajúcich databázu
        const projs = (await cmd("SMEMBERS", "projects")) || [];
        const keys = [`class:${body.classId}`];
        for (const pr of new Set([...projs, PROJECT])) keys.push(`subs:${pr}:${body.classId}`, `ovr:${pr}:${body.classId}`);
        await cmd("DEL", ...keys);
        await cmd("SREM", "classes", body.classId);
        if ((await cmd("GET", "cfg:active")) === body.classId) await cmd("DEL", "cfg:active");
        res.status(200).json({ ok: true });
        return;
      }

      case "override": {
        const { classId, studentId, exId } = body;
        if (!okClassId(classId) || !/^s\d{2}$/.test(String(studentId)) || !EX_IDS.includes(String(exId))) {
          res.status(400).json({ error: "Neplatné údaje." }); return;
        }
        const field = `${studentId}|${exId}`;
        const g = body.grade === null || body.grade === "" || body.grade === undefined ? null : parseInt(body.grade);
        if (g === null) {
          await cmd("HDEL", ovrKey(classId), field);
        } else {
          if (!(g >= 1 && g <= 5)) { res.status(400).json({ error: "Známka musí byť 1 až 5." }); return; }
          await cmd("HSET", ovrKey(classId), field, JSON.stringify({ grade: g, note: String(body.note || "").slice(0, 300) }));
        }
        res.status(200).json({ ok: true });
        return;
      }

      case "deleteSubmission": {
        if (!okClassId(body.classId) || typeof body.key !== "string" || body.key.length > 80) {
          res.status(400).json({ error: "Neplatné údaje." }); return;
        }
        await cmd("HDEL", subsKey(body.classId), body.key);
        res.status(200).json({ ok: true });
        return;
      }

      default:
        res.status(400).json({ error: "Neznáma akcia." });
    }
  } catch (e) {
    res.status(500).json({ error: "Chyba databázy.", details: String(e.message || e) });
  }
}
