// /api/evaluate.js
// Vercel Serverless Function (Node.js runtime).
// Prijme z frontendu { model, max_tokens, system, messages } a bezpečne
// zavolá Anthropic API pomocou kľúča uloženého v premennej prostredia
// ANTHROPIC_API_KEY (nastavuje sa vo Vercel dashboarde, nie v kóde).
// Kľúč sa vďaka tomu nikdy neposiela do prehliadača používateľa.

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

  const { model, max_tokens, system, messages } = req.body || {};

  if (!messages) {
    res.status(400).json({ error: "Chýba pole 'messages' v tele požiadavky." });
    return;
  }

  try {
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
      res.status(anthropicRes.status).json({
        error: data?.error?.message || "Chyba pri volaní Anthropic API.",
        details: data
      });
      return;
    }

    res.status(200).json(data);
  } catch (err) {
    res.status(500).json({ error: "Nepodarilo sa spojiť s Anthropic API.", details: String(err) });
  }
}
