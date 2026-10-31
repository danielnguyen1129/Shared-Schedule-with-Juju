// Supabase Edge Function "ai-chat": the shared AI assistant behind the app's Ask tab.
// One assistant, three sub-chats (Together, Daniel, Julie) that it remembers across.
// It checks the shared passcode, loads the schedule, to-dos and chats, asks Google Gemini,
// and saves the reply. Needs supabase-chat.sql to have been run.
// Needs one secret: GEMINI_API_KEY (Supabase → Edge Functions → Secrets).
// Optional secret GEMINI_MODEL to pin a specific model.
// Deploy with "Verify JWT" turned OFF; the passcode is the protection.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const GEMINI_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
// Tried in order: if one is busy or retired, the next one answers.
const MODELS = [Deno.env.get("GEMINI_MODEL"), "gemini-3.5-flash", "gemini-flash-latest", "gemini-3.8-flash", "gemini-flash-lite-latest"].filter(Boolean) as string[];

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
type Chat = { thread: string; author: string; content: string; created_at: string };

export function buildSystem(rows: Ev[], names: Record<string, string>, me: string, today: string, now: string, threadName = "", otherChats = "") {
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
  return `You are the shared assistant inside "Our Schedule", a calendar app used by Daniel and his girlfriend Julie. There is one shared conversation split into sub-chats: "Together" (both of them), "Daniel" and "Julie". Both of them can read every sub-chat, so you may freely refer to what either of them said anywhere. You are now replying in the ${threadName || "?"} sub-chat, to ${me}.
Today is ${today} and the local time is ${now}. Times below are 24-hour; reply using am/pm.
Help with anything they ask: planning, ideas, questions about their schedule, general questions. Keep answers short and warm, suited to reading on a phone. Use plain text or simple lists; avoid tables and headings.
You can't change the calendar yourself; if they want something added, tell them what to add.

Their shared calendar (who: Daniel, Julie, or Both). "Repeats" events recur from their start date:
${events}

Their shared to-do list:
${todos}

Recent messages in the other sub-chats (for context):
${otherChats || "(none)"}`;
}

export async function askGemini(system: string, messages: Msg[], key: string, models = MODELS): Promise<string> {
  const body = JSON.stringify({
    system_instruction: { parts: [{ text: system }] },
    contents: messages.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
  });
  let lastErr = "Couldn't reach the AI.";
  for (const model of models.slice(0, 4)) {
    let res: Response;
    try {
      res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body,
        signal: AbortSignal.timeout(45000),
      });
    } catch {
      lastErr = "The AI took too long to answer. Try again?";
      continue; // timed out or network hiccup: try the next model
    }
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

  let body: { code?: string; person?: string; thread?: string; people?: Record<string, string>; today?: string; now?: string };
  try { body = await req.json(); } catch { return reply({ error: "Bad request" }, 400); }
  const rpc = (name: string, args: Record<string, unknown>) => fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: SUPABASE_KEY },
    body: JSON.stringify({ p_code: body.code ?? "", ...args }),
  });

  // Passcode check + load the schedule in one go (list_events rejects a wrong passcode).
  const res = await rpc("list_events", {});
  if (!res.ok) return reply({ error: "Wrong passcode. Press and hold the title to re-enter it." }, 401);
  const rows = (await res.json()) as Ev[];
  const chatRes = await rpc("list_chat", {});
  if (!chatRes.ok) return reply({ error: "Run supabase-chat.sql in Supabase first." }, 500);
  const chats = (await chatRes.json()) as Chat[];

  const names: Record<string, string> = { daniel: "Daniel", juju: "Julie", both: "Both", ...(body.people ?? {}) };
  const who = (id: string) => (id === "ai" ? "Assistant" : names[id] ?? id);
  const thread = body.thread ?? "together";
  const threadName = thread === "together" ? "Together" : who(thread);
  const me = who(body.person ?? "");

  // This sub-chat becomes the Gemini conversation; consecutive turns by the same side are merged.
  const messages: Msg[] = [];
  for (const c of chats.filter((c) => c.thread === thread).slice(-40)) {
    const role = c.author === "ai" ? "assistant" : "user";
    const text = role === "user" && thread === "together" ? `${who(c.author)}: ${c.content}` : c.content;
    const last = messages[messages.length - 1];
    if (last && last.role === role) last.content += "\n" + text; else messages.push({ role, content: text });
  }
  while (messages.length && messages[0].role !== "user") messages.shift();
  if (!messages.length || messages[messages.length - 1].role !== "user") return reply({ error: "No new message to answer." }, 400);

  const otherChats = ["together", "daniel", "juju"].filter((t) => t !== thread).map((t) => {
    const recent = chats.filter((c) => c.thread === t).slice(-12);
    if (!recent.length) return "";
    return `[${t === "together" ? "Together" : who(t)} sub-chat]\n` + recent.map((c) => `${who(c.author)}: ${c.content.slice(0, 500)}`).join("\n");
  }).filter(Boolean).join("\n\n");

  try {
    const system = buildSystem(rows, names, me, body.today ?? "unknown", body.now ?? "unknown", threadName, otherChats);
    const text = await askGemini(system, messages, GEMINI_KEY);
    const saved = await rpc("add_chat", { p_thread: thread, p_author: "ai", p_content: text });
    return reply({ message: saved.ok ? await saved.json() : { thread, author: "ai", content: text } });
  } catch (err) {
    return reply({ error: err instanceof Error ? err.message : "Couldn't reach the AI." }, 502);
  }
});
