// Supabase Edge Function "notify": sends phone notifications for Our Schedule.
//   type "change"    -> tell the other person that something on the calendar changed
//   type "chat"      -> tell the other person about a message in the Together chat
//   type "test"      -> confirm notifications work on the sender's own phone
//   type "reminders" -> run every minute by pg_cron (see supabase-notify.sql). Each phone picks its own
//                       reminder times (sub.prefs: r1440 / r60 / r5 / r1 = minutes before). All-day events
//                       remind at 8am (and 8am the day before with r1440); to-dos at their start time.
// Needs secrets VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY. Deploy with "Verify JWT" turned OFF.
import webpush from "npm:web-push@3.6.7";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const APP_URL = "https://danielnguyen1129.github.io/Shared-Schedule-with-Juju/";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, apikey, authorization, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

export type Ev = {
  id: string; title: string; date: string; end_date: string | null; start_time: string | null; end_time: string | null;
  who: string; repeat: string; notes: string | null;
};
export type Prefs = { r1440?: boolean; r60?: boolean; r5?: boolean; r1?: boolean };
type Sub = { endpoint: string; person: string; sub: webpush.PushSubscription & { prefs?: Prefs }; tz: string };
const DEFAULT_PREFS: Prefs = { r60: true };
const OFFSETS: [keyof Prefs, number, string][] = [["r1440", 1440, "Tomorrow"], ["r60", 60, "In 1 hour"], ["r5", 5, "In 5 min"], ["r1", 1, "In 1 min"]];

// ---- dates (YYYY-MM-DD strings, UTC math) ----
const pad = (n: number) => String(n).padStart(2, "0");
const toD = (s: string) => { const [y, m, d] = s.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const toS = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const addDays = (s: string, n: number) => { const d = toD(s); d.setUTCDate(d.getUTCDate() + n); return toS(d); };
const diffDays = (a: string, b: string) => Math.round((toD(b).getTime() - toD(a).getTime()) / 864e5);
const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

// Does a (possibly repeating) event start on this day?
export function startsOn(e: Ev, day: string): boolean {
  if (day < e.date) return false;
  const r = e.repeat || "none";
  if (r === "none") return day === e.date;
  const n = diffDays(e.date, day);
  if (r === "daily") return true;
  if (r === "weekly") return n % 7 === 0;
  if (r === "biweekly") return n % 14 === 0;
  const a = toD(e.date), b = toD(day);
  if (a.getUTCDate() !== b.getUTCDate()) return false;
  if (r === "monthly") return true;
  if (r === "yearly") return a.getUTCMonth() === b.getUTCMonth();
  return false;
}

// Local wall-clock "now" in a time zone, as minutes (UTC-naive) plus the date string.
export function localNow(tz: string, at = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(at).map((x) => [x.type, x.value]));
  const date = `${p.year}-${p.month}-${p.day}`;
  return { date, min: Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) / 60000 };
}
const wallMin = (date: string, time: string) => {
  const [h, m] = time.split(":").map(Number);
  return toD(date).getTime() / 60000 + h * 60 + m;
};
const fmtTime = (t: string) => { let [h, m] = t.split(":").map(Number); const ap = h >= 12 ? "pm" : "am"; h = h % 12 || 12; return m ? `${h}:${pad(m)}${ap}` : `${h}${ap}`; };

// Reminders that are due for one person right now (fire if due within the last 10 minutes).
export function dueReminders(events: Ev[], person: string, tz: string, at = new Date(), prefs: Prefs = DEFAULT_PREFS) {
  const now = localNow(tz, at);
  const out: { key: string; title: string; body: string }[] = [];
  const due = (m: number) => m <= now.min && m > now.min - 10;
  for (const day of [addDays(now.date, -1), now.date, addDays(now.date, 1), addDays(now.date, 2)]) {
    for (const e of events) {
      if (e.repeat === "todo") {
        if (e.notes === "done" || !e.start_time || e.date !== day) continue;
        if (due(wallMin(day, e.start_time))) out.push({ key: `todo|${e.id}|${day}`, title: "To-do now", body: `${e.title} · ${fmtTime(e.start_time)}${e.end_time ? "–" + fmtTime(e.end_time) : ""}` });
        continue;
      }
      if (e.who !== person && e.who !== "both") continue;
      if (!startsOn(e, day)) continue;
      const tag = e.who === "both" ? " · together" : "";
      if (e.start_time) {
        const when = `${fmtTime(e.start_time)}${e.end_time ? "–" + fmtTime(e.end_time) : ""}`;
        for (const [k, mins, label] of OFFSETS) {
          if (prefs[k] && due(wallMin(day, e.start_time) - mins)) out.push({ key: `ev|${e.id}|${day}|${mins}`, title: `${label}: ${e.title}`, body: `${when}${tag}` });
        }
      } else {
        if (due(wallMin(day, "08:00"))) out.push({ key: `ev|${e.id}|${day}|8am`, title: `Today: ${e.title}`, body: "All day" + tag });
        if (prefs.r1440 && due(wallMin(day, "08:00") - 1440)) out.push({ key: `ev|${e.id}|${day}|8am-1d`, title: `Tomorrow: ${e.title}`, body: "All day" + tag });
      }
    }
  }
  return out;
}

if (import.meta.main) Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply({ error: "POST only" }, 405);
  try { webpush.setVapidDetails(APP_URL, Deno.env.get("VAPID_PUBLIC_KEY") ?? "", Deno.env.get("VAPID_PRIVATE_KEY") ?? ""); }
  catch { return reply({ error: "Add VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY in Supabase → Edge Functions → Secrets." }, 500); }
  let body: { code?: string; type?: string; from?: string; title?: string; text?: string; endpoint?: string };
  try { body = await req.json(); } catch { return reply({ error: "Bad request" }, 400); }
  const rpc = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
      method: "POST", headers: { "Content-Type": "application/json", apikey: SUPABASE_KEY },
      body: JSON.stringify({ p_code: body.code ?? "", ...args }),
    });
    if (!r.ok) throw new Error(`${name} failed (${r.status})`);
    const t = await r.text();
    return t ? JSON.parse(t) : null;
  };

  let subs: Sub[];
  try { subs = await rpc("list_push"); } catch { return reply({ error: "Wrong passcode, or supabase-notify.sql hasn't been run." }, 401); }

  const send = async (s: Sub, title: string, text: string, tag?: string) => {
    try {
      const { endpoint, keys } = s.sub;
      await webpush.sendNotification({ endpoint, keys }, JSON.stringify({ title, body: text, url: APP_URL, tag }), { TTL: 3600 });
      return true;
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) await rpc("delete_push", { p_endpoint: s.endpoint }).catch(() => {});
      return false;
    }
  };

  if (body.type === "reminders") {
    const events = (await rpc("list_events")) as Ev[];
    let sent = 0;
    for (const s of subs) {
      for (const r of dueReminders(events, s.person, s.tz, new Date(), { ...DEFAULT_PREFS, ...(s.sub.prefs ?? {}) })) {
        if (await rpc("mark_sent", { p_key: `${s.endpoint.slice(-40)}|${r.key}` })) { if (await send(s, r.title, r.body, r.key)) sent++; }
      }
    }
    return reply({ sent });
  }

  const title = (body.title ?? "Our Schedule").slice(0, 100), text = (body.text ?? "").slice(0, 300);
  const targets = body.type === "test" ? subs.filter((s) => s.endpoint === body.endpoint)
    : subs.filter((s) => s.person !== body.from);
  const results = await Promise.all(targets.map((s) => send(s, title, text)));
  return reply({ sent: results.filter(Boolean).length });
});
