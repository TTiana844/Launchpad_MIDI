# Launchpad Mini — odovzdávací systém s AI hodnotením

Statická webová aplikácia (`index.html`) + Vercel serverless funkcie v `api/`,
ktoré bezpečne volajú Anthropic API, hodnotenie ukladajú do databázy a poskytujú
učiteľovi tabuľku známok. API kľúč sa nikdy neposiela do prehliadača — žije len
na serveri ako premenná prostredia. Rovnaká architektúra ako Audio Lab, OBS Lab,
Insta360 Lab a AKAI APC Key 25.

## Štruktúra projektu

```
.
├── index.html                     # celá aplikácia (frontend, 10 cvičení, tutoriály)
├── Launchpad_Mini_Ucebnica.pdf    # kompletná ilustrovaná učebnica (12 kapitol)
├── api/
│   ├── evaluate.js                # overí odovzdanie, zavolá Anthropic API a výsledok uloží do databázy
│   ├── config.js                  # verejne: aktívna trieda a mená na výber pre žiakov
│   ├── teacher.js                 # chránené heslom: tabuľka, triedy, ručné známky, mazanie
│   └── _db.js                     # pomocná vrstva nad Upstash Redis (nie je samostatná adresa)
├── package.json
├── .gitignore
└── README.md
```

## Ako to funguje (odovzdávanie do databázy)

- **Trieda a žiaci:** učiteľ vloží zoznam mien (max. 40) a tým vytvorí triedu. Žiaci si pri
  odovzdávaní vyberú meno zo zoznamu — nepíšu ho, preto sa mená nerozchádzajú. Tímy
  (cvičenia 2–4 členov s rolami) sa tiež skladajú z mien zo zoznamu.
- **Jedno odovzdanie = jedno cvičenie pre jedného žiaka alebo pre celý tím.** Tímové odovzdanie
  sa započíta každému členovi; odovzdať ho stačí jednému.
- **Hodnotenie ukladá server**, nie prehliadač žiaka. Žiak nič nesťahuje ani neposiela a nemá
  kde upraviť známku. Žiacka kópia hodnotenia v prehliadači slúži len na zobrazenie spätnej väzby.
- **Opakované odovzdanie:** uchová sa posledných 10 pokusov, do tabuľky ide najlepší.
- **Ak AI zlyhá**, odovzdanie sa zaznamená ako „čaká na ručné hodnotenie“ (v tabuľke „…“) a
  známku zadáš ručne. Žiak dostane len orientačný odhad.
- **Učiteľ** (záložka *Učiteľský prehľad*, za heslom) vidí tabuľku žiaci × 10 cvičení, v detaile
  komentár žiaka, odkaz na jeho súbory na Google Drive, role v tíme a hodnotenie AI. Môže zadať
  ručnú známku (platí len pre daného žiaka) a exportovať tabuľku do CSV pre Excel.
- **Nový školský rok:** *Nová trieda* → vlož nový zoznam. Stará trieda ostáva uložená aj s
  hodnoteniami (prepínač hore).
- **Viac projektov, jedna databáza:** zoznam tried je spoločný pre všetky aplikácie (Mixpult,
  Launchpad, …), ktoré používajú tú istú databázu — zoznam žiakov vložíš raz. Odovzdania a
  ručné známky sú oddelené podľa projektu (konštanta `PROJECT` v `api/_db.js`).
  Zmazanie triedy zmaže jej známky vo všetkých projektoch.
- Screenshoty sa v databáze neukladajú — AI ich vidí pri odovzdaní a súbory majú žiaci na
  zdieľanom Google Drive (odkaz na Google Drive je pri odovzdaní povinný a uloží sa k odovzdaniu).

## Čo je nové oproti predošlej verzii

- Odovzdávanie priamo do databázy — export/import `.json` súborov odpadol.
- Výber žiakov zo zoznamu triedy, učiteľská tabuľka a export do CSV.
- Zo žiackej časti zmizla „učiteľská korekcia známky“ (známku už mení len učiteľ v tabuľke).

## Čo appka robí (nezmenené)

- **Model `claude-haiku-4-5-20251001`**, `max_tokens` 1500, prompt caching systémového promptu.
- **Skutočné súbory** — appka reálne prečíta obrázky (.png/.jpg/.jpeg/.webp/.gif do 4 MB) a pošle
  ich AI. Video/audio/MIDI súbory sa evidujú len podľa názvu.
- **Tvrdá poistka pred odoslaním** — bez aspoň jedného súboru a bez zmysluplného komentára
  (min. ~15 znakov) sa práca nedá odovzdať.
- **Prísny systémový prompt pre AI** — checklist sám osebe nestačí na vysoké skóre.
- **Link na celú učebnicu** (PDF) v hlavičke aj pri každom cvičení.

## 1. Nahratie na GitHub

```bash
git init
git add .
git commit -m "Launchpad ulohy s AI hodnotenim"
git branch -M main
git remote add origin https://github.com/<tvoj-ucet>/<repo>.git
git push -u origin main
```

## 2. Import projektu do Vercelu

1. vercel.com -> Add New -> Project.
2. Vyber svoj GitHub repozitar.
3. Framework Preset: Other. Build Command a Output Directory nechaj prazdne.

## 3. Nastavenie API klúca

1. Settings -> Environment Variables:
   - Name: `ANTHROPIC_API_KEY`
   - Value: kluc z console.anthropic.com/settings/keys (Scope: Default)
   - Environment: Production, Preview aj Development.
2. Ak dostanes chybu o "anthropic-workspace-id", pridaj aj
   `ANTHROPIC_WORKSPACE_ID`.
3. Deployments -> Redeploy (bez "Use existing Build Cache").

### Databáza (Upstash Redis)

1. Vo Verceli otvor projekt → **Storage** (alebo **Marketplace**) → **Upstash Redis** → vytvor
   databázu (bezplatný plán stačí, región vyber v EÚ) a **Connect Project**. Ak už databázu máš
   z Mixpultu, pripoj tú istú — zoznam tried sa potom zdieľa.
2. Vercel sám pridá premenné `KV_REST_API_URL` a `KV_REST_API_TOKEN` (alebo
   `UPSTASH_REDIS_REST_URL` a `UPSTASH_REDIS_REST_TOKEN` — podporované sú obe dvojice).

### Heslo učiteľa

Vo Vercel → Settings → Environment Variables pridaj `TEACHER_PASSWORD` (tvoje heslo do
učiteľského prehľadu; môže byť rovnaké vo všetkých projektoch), Production + Preview + Development,
potom **Redeploy**. Bez hesla alebo bez databázy sa učiteľský prehľad neotvorí a žiaci uvidia upozornenie.

### Prvé spustenie

Otvor appku → **Učiteľský prehľad** → prihlás sa heslom → **Nová trieda** → názov (napr.
`4.A 2026/27`) a zoznam žiakov, jeden na riadok → **Uložiť**. Trieda sa nastaví ako aktívna.
(Ak už triedu vytvoril Mixpult na rovnakej databáze, objaví sa tu automaticky.)

## 4. Otestovanie

Vyber cvičenie, vyber svoje meno zo zoznamu, priloz subor, napis komentar, odosli — odovzdanie sa objaví v učiteľskej tabuľke. Skontroluj aj tlacidlo
„Celá učebnica (PDF)" v hlavičke — malo by otvoriť
`Launchpad_Mini_Ucebnica.pdf` v novej karte.

## Aktualizácia obsahu

Stačí nahradiť `index.html` alebo `Launchpad_Mini_Ucebnica.pdf` v repozitári.
Ak zmeníš názov PDF súboru, uprav aj odkazy `href` v `index.html`.
