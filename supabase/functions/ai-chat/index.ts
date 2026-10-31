// Supabase Edge Function "ai-chat": the private AI assistant behind the app's Ask tab.
// It checks the shared passcode, loads your schedule + to-dos, and asks Google Gemini.
// Needs one secret: GEMINI_API_KEY (Supabase → Edge Functions → Secrets).
// Optional secret GEMINI_MODEL to pin a specific model.
// Deploy with "Verify JWT" turned OFF; the passcode is the protection.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const GEMINI_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
// Tried in order: if one is busy or retired, the next one answers.
const MODELS = [Deno.env.get("GEMINI_MODEL"), "gemini-flash-latest", "gemini-3.8-flash", "gemini-3.5-flash"].filter(Boolean) as string[];

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, apikey, authorization, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

type Ev = {
  title: string; date: string; end_date: string | null; start_time: string | null; end_time: string | null;
  who: string; repeat: string; location: string | null; notes: string | null;
};
type Msg = { role: string; content: string };

export function buildSystem(rows: Ev[], names: Record<string, string>, me: string, today: string, now: string) {
  const t = (s: string | null) => (s ? s.slice(0, 5) : "");
  const fmt = (e: Ev) => {
    const time = e.start_time ? ` ${t(e.start_time)}${e.end_time ? "-" + t(e.end_time) : ""}` : " (all day)";
    const span = e.end_date && e.end_date > e.date ? ` to ${e.end_date}` : "";
    const rep = e.repeat !== "none" ? ` [repeats ${e.repeat}]` : "";
    const extra = [e.location && `at ${e.location}`, e.notes && `notes: ${e.notes}`].filter(Boolean).join("; ");
    return `- ${e.date}${span}${time}${rep} · ${names[e.who] ?? e.who} · ${e.title}${extra ? ` (${extra})` : ""}`;
  };
  const events = rows.filter((e) => e.repeat !== "todo").map(fmt).join("\n") || "(nothing scheduled)";
  const todos = rows.filter((e) => e.repeat === "todo").map((x) =>
    `- [${x.notes === "done" ? "x" : " "}] ${x.start_time ? t(x.start_time) + (x.end_time ? "-" + t(x.end_time) : "") + " " : ""}${x.title}`
  ).join("\n") || "(empty)";
  return `You are a friendly personal assistant inside "Our Schedule", a shared calendar app used by Daniel and his girlfriend Julie. You are chatting privately with ${me}; the other person can't see this chat.
Today is ${today} and the local time is ${now}. Times below are 24-hour; reply using am/pm.
Help with anything they ask: planning, ideas, questions about their schedule, general questions. Keep answers short and warm, suited to reading on a phone. Use plain text or simple lists; avoid tables and headings.
You can't change the calendar yourself; if they want something added, tell them what to add.

Their shared calendar (who: Daniel, Julie, or Both). "Repeats" events recur from their start date:
${events}

Their shared to-do list:
${todos}`;
}

export async function askGemini(system: string, messages: Msg[], key: string, models = MODELS): Promise<string> {
  const body = JSON.stringify({
    system_instruction: { parts: [{ text: system }] },
    contents: messages.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
  });
  let lastErr = "Couldn't reach the AI.";
  for (const model of models) {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body,
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      const cand = data.candidates?.[0];
      const text = (cand?.content?.parts ?? []).map((p: { text?: string }) => p.text ?? "").join("").trim();
      if (text) return text;
      if (data.promptFeedback?.blockReason || cand?.finishReason === "SAFETY") return "Sorry, I can't help with that one.";
      lastErr = "The AI gave an empty answer. Try again?";
      continue;
    }
    if (res.status === 400 && /api key/i.test(data.error?.message ?? "")) throw new Error("The Gemini key in Supabase isn't valid.");
    if (res.status === 401 || res.status === 403) throw new Error("The Gemini key in Supabase isn't valid.");
    lastErr = res.status === 429 ? "The free AI limit was hit. Try again in a minute." : "The AI is busy right now. Try again in a minute.";
    // 404 (retired model), 429 (limit) or 5xx (busy): try the next model
  }
  throw new Error(lastErr);
}

if (import.meta.main) Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply({ error: "POST only" }, 405);
  if (!GEMINI_KEY) return reply({ error: "Add GEMINI_API_KEY in Supabase → Edge Functions → Secrets." }, 500);

  let body: { code?: string; person?: string; people?: Record<string, string>; today?: string; now?: string; messages?: Msg[] };
  try { body = await req.json(); } catch { return reply({ error: "Bad request" }, 400); }

  // Passcode check + load the schedule in one go (list_events rejects a wrong passcode).
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/list_events`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: SUPABASE_KEY },
    body: JSON.stringify({ p_code: body.code ?? "" }),
  });
  if (!res.ok) return reply({ error: "Wrong passcode. Press and hold the title to re-enter it." }, 401);
  const rows = (await res.json()) as Ev[];

  const names = body.people ?? { daniel: "Daniel", juju: "Julie", both: "Both" };
  const me = names[body.person ?? ""] ?? "the user";
  const messages = (body.messages ?? [])
    .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .slice(-30)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 8000) }));
  if (!messages.length || messages[messages.length - 1].role !== "user") return reply({ error: "No message" }, 400);

  try {
    const text = await askGemini(buildSystem(rows, names, me, body.today ?? "unknown", body.now ?? "unknown"), messages, GEMINI_KEY);
    return reply({ text });
  } catch (err) {
    return reply({ error: err instanceof Error ? err.message : "Couldn't reach the AI." }, 502);
  }
});
