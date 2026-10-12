// /api/_db.js
// Tenká vrstva nad Upstash Redis (REST API) — bez npm závislostí.
// Premenné prostredia pridá Vercel sám, keď k projektu pripojíš Upstash Redis
// (Vercel → Storage / Marketplace → Upstash Redis → Connect Project):
//   KV_REST_API_URL + KV_REST_API_TOKEN   (alebo UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN)
//
// Kľúče v databáze:
//   cfg:active        -> id aktívnej triedy (text)
//   classes           -> množina id všetkých tried
//   class:<id>        -> JSON { id, name, students:[{id:"s01", name:"..."}], createdAt }
//   projects          -> množina projektov, ktoré používajú túto databázu (mixpult, launchpad, …)
//   subs:<projekt>:<id> -> hash: "<cvičenie>|<s01+s04>" -> JSON { exId, members, attempts:[...] }
//   ovr:<projekt>:<id>  -> hash: "<s01>|<cvičenie>" -> JSON { grade, note }  (ručná známka učiteľa)
//
// Zoznamy tried (classes, class:<id>, cfg:active) sú ZDIEĽANÉ medzi projektmi, ak viaceré
// aplikácie používajú tú istú databázu — zoznam žiakov stačí vložiť raz. Odovzdania a ručné
// známky sú oddelené podľa projektu (konštanta PROJECT nižšie).

export const PROJECT = "launchpad";
export const subsKey = id => `subs:${PROJECT}:${id}`;
export const ovrKey = id => `ovr:${PROJECT}:${id}`;

const base = () => process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const token = () => process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

export const dbConfigured = () => !!(base() && token());

export async function cmd(...args) {
  const r = await fetch(base(), {
    method: "POST",
    headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" },
    body: JSON.stringify(args.map(String))
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.error) throw new Error(d.error || `DB ${r.status}`);
  return d.result;
}

export async function hgetall(key) {
  const res = (await cmd("HGETALL", key)) || [];
  if (!Array.isArray(res)) return res;
  const o = {};
  for (let i = 0; i < res.length; i += 2) o[res[i]] = res[i + 1];
  return o;
}

export async function getJSON(key) {
  const v = await cmd("GET", key);
  return v ? JSON.parse(v) : null;
}

export const setJSON = (key, val) => cmd("SET", key, JSON.stringify(val));

export async function getActiveClass() {
  const id = await cmd("GET", "cfg:active");
  return id ? await getJSON(`class:${id}`) : null;
}
