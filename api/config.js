// /api/config.js
// Verejná (bez hesla) konfigurácia pre žiakov: aktívna trieda a zoznam mien na výber.
// Vracia len id a mená — žiadne známky ani odovzdania.

import { dbConfigured, getActiveClass } from "./_db.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!dbConfigured()) {
    res.status(200).json({ ok: false, reason: "no_db" });
    return;
  }
  try {
    const cls = await getActiveClass();
    if (!cls) {
      res.status(200).json({ ok: false, reason: "no_class" });
      return;
    }
    res.status(200).json({
      ok: true,
      cls: {
        id: cls.id,
        name: cls.name,
        students: cls.students.filter(s => s.name)
      }
    });
  } catch (e) {
    res.status(500).json({ ok: false, reason: "db_error", error: String(e.message || e) });
  }
}
