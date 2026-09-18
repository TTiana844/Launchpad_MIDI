# Launchpad Mini — odovzdávací systém s AI hodnotením

Statická webová aplikácia (`index.html`) + jedna Vercel serverless funkcia
(`api/evaluate.js`), ktorá bezpečne volá Anthropic API a vracia AI hodnotenie
odovzdanej práce. API kľúč sa nikdy neposiela do prehliadača — žije len na
serveri ako premenná prostredia. Rovnaká architektúra ako Audio Lab, OBS Lab,
Insta360 Lab a AKAI APC Key 25.

## Štruktúra projektu

```
.
├── index.html                     # celá aplikácia (frontend, 10 cvičení, tutoriály)
├── Launchpad_Mini_Ucebnica.pdf    # kompletná ilustrovaná učebnica (12 kapitol)
├── api/
│   └── evaluate.js                # serverless funkcia - volá Anthropic API
├── package.json
├── .gitignore
└── README.md
```

## Čo je nové v tejto verzii (zladenie s ostatnými projektmi)

- **Model prepnutý na `claude-haiku-4-5-20251001`** (namiesto Sonnetu) a
  `max_tokens` znížený z 1200 na 600 — rovnaká optimalizácia nákladov ako pri
  Audio Labe, OBS Labe, Insta360 Labe a MIDI Keys, dôležité pri ~160 žiakoch.
- **Prompt caching** — systémový prompt je rozdelený na dva bloky presne podľa
  vzoru MIDI Keys: veľký spoločný blok pravidiel hodnotenia má
  `cache_control:{type:"ephemeral"}` (rovnaký pre všetky cvičenia aj
  odovzdania, takže sa neúčtuje pri každom volaní), malý premenlivý blok
  obsahuje len tímové/individuálne hodnotenie a JSON schému s kritériami
  konkrétneho cvičenia.
- **Link na celú učebnicu** — v hlavičke appky pribudla dlaždica „Celá
  učebnica (PDF)", ktorá otvára `Launchpad_Mini_Ucebnica.pdf` v novej karte.
  Každé cvičenie má navyše v rozbaľovacom tutoriáli odkaz priamo na
  konkrétnu kapitolu a stranu učebnice (`#page=N`).
- **Skutočné ilustrácie namiesto textového popisku** — každé z 10 cvičení má
  teraz vloženú reálnu fotografiu/infografiku (base64, optimalizovaná na
  ~50-90 KB), vybranú priamo z ilustrovanej učebnice.

## Čo appka robí (nezmenené oproti predošlej verzii)

- **Skutočné súbory namiesto simulácie** — appka reálne prečíta obrázky
  (.png/.jpg/.jpeg/.webp/.gif do 4 MB) a pošle ich AI ako reálny obrazový
  obsah. Video/audio/MIDI súbory sa evidujú len podľa názvu.
- **Tvrdá poistka pred odoslaním** — bez aspoň jedného súboru a bez
  zmysluplného komentára (min. ~15 znakov) sa práca nedá odovzdať.
- **Prísny systémový prompt pre AI** — checklist sám osebe nestačí na vysoké
  skóre; musí byť podložený obrázkom alebo konkrétnym komentárom.
- **Uloženie do localStorage a export/import odovzdaní (.json)** s
  automatickou detekciou duplicít v „Učiteľskom prehľade".

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

## 4. Otestovanie

Vyber cvičenie, priloz subor, napis komentar, odosli. Skontroluj aj tlacidlo
„Celá učebnica (PDF)" v hlavičke — malo by otvoriť
`Launchpad_Mini_Ucebnica.pdf` v novej karte.

## Aktualizácia obsahu

Stačí nahradiť `index.html` alebo `Launchpad_Mini_Ucebnica.pdf` v repozitári.
Ak zmeníš názov PDF súboru, uprav aj odkazy `href` v `index.html`.
