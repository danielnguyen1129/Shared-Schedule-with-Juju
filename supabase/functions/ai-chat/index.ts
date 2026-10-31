// Supabase Edge Function "ai-chat": the private AI assistant behind the app's Ask tab.
// It checks the shared passcode, loads your schedule + to-dos, and asks Claude.
// Needs one secret: ANTHROPIC_API_KEY (Supabase → Edge Functions → Secrets).
// Deploy with "Verify JWT" turned OFF; the passcode is the protection.
import Anthropic from "npm:@anthropic-ai/sdk";

const anthropic = new Anthropic(); // reads ANTHROPIC_API_KEY
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply({ error: "POST only" }, 405);

  let body: { code?: string; person?: string; people?: Record<string, string>; today?: string; now?: string; messages?: { role: string; content: string }[] };
  try { body = await req.json(); } catch { return reply({ error: "Bad request" }, 400); }

  // Passcode check + load the schedule in one go (list_events rejects a wrong passcode).
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/list_events`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: SUPABASE_KEY },
    body: JSON.stringify({ p_code: body.code ?? "" }),
  });
  if (!res.ok) return reply({ error: "wrong passcode" }, 401);
  const rows = (await res.json()) as Ev[];

  const names = body.people ?? { daniel: "Daniel", juju: "Julie", both: "Both" };
  const me = names[body.person ?? ""] ?? "the user";
  const fmt = (e: Ev) => {
    const time = e.start_time ? ` ${e.start_time.slice(0, 5)}${e.end_time ? "-" + e.end_time.slice(0, 5) : ""}` : " (all day)";
    const span = e.end_date && e.end_date > e.date ? ` to ${e.end_date}` : "";
    const rep = e.repeat !== "none" ? ` [repeats ${e.repeat}]` : "";
    const extra = [e.location && `at ${e.location}`, e.notes && `notes: ${e.notes}`].filter(Boolean).join("; ");
    return `- ${e.date}${span}${time}${rep} · ${names[e.who] ?? e.who} · ${e.title}${extra ? ` (${extra})` : ""}`;
  };
  const events = rows.filter((e) => e.repeat !== "todo").map(fmt).join("\n") || "(nothing scheduled)";
  const todos = rows.filter((e) => e.repeat === "todo").map((t) =>
    `- [${t.notes === "done" ? "x" : " "}] ${t.start_time ? t.start_time.slice(0, 5) + (t.end_time ? "-" + t.end_time.slice(0, 5) : "") + " " : ""}${t.title}`
  ).join("\n") || "(empty)";

  const system = `You are a friendly personal assistant inside "Our Schedule", a shared calendar app used by Daniel and his girlfriend Julie. You are chatting privately with ${me}; the other person can't see this chat.
Today is ${body.today ?? "unknown"} and the local time is ${body.now ?? "unknown"}.
Help with anything they ask: planning, ideas, questions about their schedule, general questions. Keep answers short and warm, suited to reading on a phone. Use plain text or simple lists; avoid tables and headings.
You can't change the calendar yourself; if they want something added, tell them what to add.

Their shared calendar (who: Daniel, Julie, or Both). "Repeats" events recur from their start date:
${events}

Their shared to-do list:
${todos}`;

  const messages = (body.messages ?? [])
    .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .slice(-30)
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content.slice(0, 8000) }));
  if (!messages.length || messages[messages.length - 1].role !== "user") return reply({ error: "No message" }, 400);

  try {
    // fallbacks: "default" re-runs a safety-declined request on Anthropic's recommended fallback model.
    const params = {
      model: "claude-opus-5-5",
      max_tokens: 16000,
      output_config: { effort: "low" },
      system,
      messages,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    };
    // deno-lint-ignore no-explicit-any
    const response = await anthropic.beta.messages.create(params as any);
    if (response.stop_reason === "refusal") return reply({ text: "Sorry, I can't help with that one." });
    const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n").trim();
    return reply({ text: text || "Hmm, I didn't get a response. Try again?" });
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) return reply({ error: "The AI key in Supabase isn't valid." }, 502);
    if (err instanceof Anthropic.RateLimitError) return reply({ error: "The AI is busy right now. Try again in a minute." }, 502);
    if (err instanceof Anthropic.APIError) return reply({ error: `AI error (${err.status}). Check your Anthropic credit balance.` }, 502);
    return reply({ error: "Couldn't reach the AI." }, 502);
  }
});
