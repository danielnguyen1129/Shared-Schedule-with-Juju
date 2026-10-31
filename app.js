(() => {
  "use strict";
  const CFG = window.SCHEDULE_CONFIG || {};
  const PEOPLE = CFG.people || [];
  const REMOTE = !!(CFG.supabaseUrl && CFG.supabaseAnonKey);
  const $ = id => document.getElementById(id);
  const LS = {
    get: (k, d) => { try { const v = localStorage.getItem("os." + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set: (k, v) => localStorage.setItem("os." + k, JSON.stringify(v)),
  };

  // ---------- dates (all as "YYYY-MM-DD" strings, math in UTC to dodge DST) ----------
  const pad = n => String(n).padStart(2, "0");
  const toD = s => { const [y, m, d] = s.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)); };
  const toS = d => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const addDays = (s, n) => { const d = toD(s); d.setUTCDate(d.getUTCDate() + n); return toS(d); };
  const diffDays = (a, b) => Math.round((toD(b) - toD(a)) / 864e5);
  const todayS = () => { const n = new Date(); return `${n.getFullYear()}-${pad(n.getMonth() + 1)}-${pad(n.getDate())}`; };
  const daysInMonth = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate(); // m is 0-based
  const fmtTime = t => {
    if (!t) return "";
    let [h, m] = t.split(":").map(Number);
    const ap = h >= 12 ? "pm" : "am"; h = h % 12 || 12;
    return m ? `${h}:${pad(m)}${ap}` : `${h}${ap}`;
  };
  const fmtDay = s => {
    const t = todayS();
    if (s === t) return "Today";
    if (s === addDays(t, 1)) return "Tomorrow";
    if (s === addDays(t, -1)) return "Yesterday";
    const d = toD(s), opts = { weekday: "long", month: "short", day: "numeric", timeZone: "UTC" };
    if (d.getUTCFullYear() !== new Date().getFullYear()) opts.year = "numeric";
    return d.toLocaleDateString(undefined, opts);
  };
  const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];

  // Start dates of an event's occurrences that overlap [from, to]
  function occurrences(e, from, to) {
    const dur = e.end_date && e.end_date > e.date ? diffDays(e.date, e.end_date) : 0;
    const out = [];
    const lo = addDays(from, -dur); // an occurrence starting here still overlaps `from`
    const r = e.repeat || "none";
    if (r === "none") { if (e.date <= to && e.date >= lo) out.push(e.date); return out; }
    if (r === "daily" || r === "weekly" || r === "biweekly") {
      const step = r === "daily" ? 1 : r === "weekly" ? 7 : 14;
      let s = e.date;
      if (s < lo) s = addDays(s, Math.ceil(diffDays(s, lo) / step) * step);
      for (; s <= to; s = addDays(s, step)) out.push(s);
      return out;
    }
    const base = toD(e.date), day = base.getUTCDate();
    let y = base.getUTCFullYear(), m = base.getUTCMonth();
    const loD = toD(lo);
    if (r === "monthly") {
      const skip = (loD.getUTCFullYear() - y) * 12 + loD.getUTCMonth() - m - 1;
      if (skip > 0) { m += skip; y += Math.floor(m / 12); m %= 12; }
    } else if (r === "yearly") {
      if (loD.getUTCFullYear() - 1 > y) y = loD.getUTCFullYear() - 1;
    }
    for (let i = 0; i < 400; i++) {
      if (day <= daysInMonth(y, m)) {
        const s = `${y}-${pad(m + 1)}-${pad(day)}`;
        if (s > to) break;
        if (s >= lo && s >= e.date) out.push(s);
      }
      if (r === "monthly") { m++; if (m > 11) { m = 0; y++; } } else y++;
    }
    return out;
  }

  // Map of day -> [{e, start}] for range
  function buildDays(events, from, to) {
    const map = {};
    for (const e of events) {
      if (e.repeat === "todo") continue;
      if (filter !== "all" && e.who !== filter && e.who !== "both") continue;
      const dur = e.end_date && e.end_date > e.date ? diffDays(e.date, e.end_date) : 0;
      for (const s of occurrences(e, from, to)) {
        for (let i = 0; i <= dur; i++) {
          const day = addDays(s, i);
          if (day < from || day > to) continue;
          (map[day] ||= []).push({ e, start: s, idx: i, dur });
        }
      }
    }
    for (const k in map) map[k].sort((a, b) => {
      const at = a.idx > 0 ? "" : (a.e.start_time || ""), bt = b.idx > 0 ? "" : (b.e.start_time || "");
      return at.localeCompare(bt) || a.e.title.localeCompare(b.e.title);
    });
    markClashes(map);
    return map;
  }

  // Flag timed events that overlap on the same day (e.g. Daniel's gym vs a dinner together)
  const mins = t => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
  function markClashes(map) {
    for (const day in map) {
      const timed = map[day].filter(it => it.dur === 0 && it.e.start_time);
      for (const it of map[day]) it.clash = [];
      for (let i = 0; i < timed.length; i++) for (let j = i + 1; j < timed.length; j++) {
        const a = timed[i], b = timed[j];
        if (a.e.id === b.e.id) continue;
        const as = mins(a.e.start_time), ae = a.e.end_time && mins(a.e.end_time) > as ? mins(a.e.end_time) : as + 60;
        const bs = mins(b.e.start_time), be = b.e.end_time && mins(b.e.end_time) > bs ? mins(b.e.end_time) : bs + 60;
        if (as < be && bs < ae) { a.clash.push(b); b.clash.push(a); }
      }
    }
  }

  // ---------- storage ----------
  let events = LS.get("events", []);
  let me = LS.get("me", null);
  let code = LS.get("code", "");
  let filter = LS.get("filter", "all");

  async function rpc(name, body) {
    const res = await fetch(`${CFG.supabaseUrl.replace(/\/$/, "")}/rest/v1/rpc/${name}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json", apikey: CFG.supabaseAnonKey,
        // legacy anon keys are JWTs and go in Authorization too; new "publishable" keys must not
        ...(CFG.supabaseAnonKey.startsWith("eyJ") ? { Authorization: `Bearer ${CFG.supabaseAnonKey}` } : {}),
      },
      body: JSON.stringify({ p_code: code, ...body }),
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) {
      const err = new Error((data && data.message) || `HTTP ${res.status}`);
      err.badCode = data && (data.code === "28P01" || /passcode/.test(data.message || ""));
      throw err;
    }
    return data;
  }
  const api = REMOTE ? {
    list: () => rpc("list_events", {}),
    save: e => rpc("save_event", { e }),
    remove: id => rpc("delete_event", { p_id: id }),
  } : {
    list: async () => LS.get("events", []),
    save: async e => { e = { ...e, id: e.id || crypto.randomUUID(), updated_at: new Date().toISOString() }; e.created_at ||= e.updated_at;
      const all = LS.get("events", []).filter(x => x.id !== e.id); all.push(e); LS.set("events", all); return e; },
    remove: async id => LS.set("events", LS.get("events", []).filter(x => x.id !== id)),
  };

  const normalize = e => ({ ...e,
    start_time: e.start_time ? e.start_time.slice(0, 5) : null,
    end_time: e.end_time ? e.end_time.slice(0, 5) : null });

  function setSync(state) { $("sync").className = "sync " + state; $("sync").title = { "": "Up to date", busy: "Syncing…", err: "Can't reach the server", off: "Demo mode (this device only)" }[state]; }

  let loading = false;
  async function refresh() {
    if (loading || !me) return;
    loading = true; if (REMOTE) setSync("busy");
    try {
      events = (await api.list()).map(normalize);
      if (filter === "ai") loadChat();
      LS.set("events", events);
      setSync(REMOTE ? "" : "off");
      render();
    } catch (err) {
      if (err.badCode) { showSetup("That passcode didn't work."); }
      else setSync("err");
    } finally { loading = false; }
  }

  // ---------- UI ----------
  let view = LS.get("view", "list");
  let cursor = todayS().slice(0, 7); // YYYY-MM for month view
  let selected = todayS();
  let listDays = 60;
  const person = id => PEOPLE.find(p => p.id === id) || { id, name: id || "?", color: "#9ca3af" };

  function toast(msg) {
    const t = $("toast"); t.textContent = msg; t.classList.remove("hidden");
    clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.add("hidden"), Math.max(2400, msg.length * 70));
  }

  function segButtons(el, options, value, onPick) {
    el.innerHTML = "";
    for (const o of options) {
      const b = document.createElement("button"); b.type = "button";
      b.innerHTML = `<span class="dot" style="--c:${o.color}"></span>`; b.append(o.name);
      b.className = o.id === value ? "on" : "";
      b.onclick = () => { [...el.children].forEach(c => c.classList.remove("on")); b.classList.add("on"); onPick(o.id); };
      el.append(b);
    }
  }

  function eventButton({ e, start, idx, dur, clash }) {
    const p = person(e.who);
    const b = document.createElement("button"); b.className = "event" + (clash && clash.length ? " clash" : ""); b.style.setProperty("--c", p.color);
    let time;
    if (dur > 0 && idx > 0 && idx < dur) time = "All day";
    else if (dur > 0 && idx === dur) time = e.end_time ? "until " + fmtTime(e.end_time) : "All day";
    else time = e.start_time ? fmtTime(e.start_time) : "All day";
    const subs = [p.name];
    if (dur > 0) subs.push(`Day ${idx + 1} of ${dur + 1}`);
    else if (e.start_time && e.end_time) subs.push(`${fmtTime(e.start_time)}–${fmtTime(e.end_time)}`);
    if (e.location) subs.push(e.location);
    if (e.repeat && e.repeat !== "none") subs.push("↻");
    b.innerHTML = `<span class="bar"></span><span class="time"></span><span class="body"><div class="t"></div><div class="sub"></div></span>`;
    b.querySelector(".time").textContent = time;
    b.querySelector(".t").textContent = e.title;
    b.querySelector(".sub").textContent = subs.join(" · ");
    if (clash && clash.length) {
      const w = document.createElement("div"); w.className = "clash-note";
      w.textContent = "⚠ Overlaps with " + clash.map(c => `${c.e.title} (${person(c.e.who).name})`).join(", ");
      b.querySelector(".body").append(w);
    }
    b.onclick = () => openSheet(e, start);
    return b;
  }

  function renderList() {
    const el = $("list-view"); el.innerHTML = "";
    const from = todayS(), to = addDays(from, listDays);
    const map = buildDays(events, from, to);
    const days = Object.keys(map).sort();
    const clashes = new Set();
    for (const d of days) for (const it of map[d]) if (it.clash.length) clashes.add(d);
    if (clashes.size) {
      const n = document.createElement("div"); n.className = "clash-banner";
      n.textContent = `⚠ ${clashes.size} day${clashes.size > 1 ? "s have" : " has"} overlapping plans coming up. Look for the red cards.`;
      el.append(n);
    }
    if (!days.length) {
      el.innerHTML = `<div class="empty">Nothing planned in the next ${listDays} days.<br>Tap <b>+</b> to add something fun.</div>`;
    }
    for (const d of days) {
      const g = document.createElement("div"); g.className = "day-group";
      const h = document.createElement("div"); h.className = "day-head" + (d === from ? " today" : ""); h.textContent = fmtDay(d);
      g.append(h, ...map[d].map(eventButton)); el.append(g);
    }
    const more = document.createElement("button"); more.className = "btn more"; more.textContent = "Show further ahead";
    more.onclick = () => { listDays += 90; renderList(); };
    el.append(more);
  }

  function renderMonth() {
    const [y, m] = cursor.split("-").map(Number);
    $("title").textContent = `${MONTHS[m - 1]} ${y}`;
    const first = `${cursor}-01`, startPad = toD(first).getUTCDay();
    const gridStart = addDays(first, -startPad);
    const cells = Math.ceil((startPad + daysInMonth(y, m - 1)) / 7) * 7;
    const gridEnd = addDays(gridStart, cells - 1);
    const map = buildDays(events, gridStart, gridEnd);
    const grid = $("grid"); grid.innerHTML = "";
    const t = todayS();
    for (let i = 0; i < cells; i++) {
      const d = addDays(gridStart, i);
      const c = document.createElement("button");
      c.className = "cell" + (d.slice(0, 7) !== cursor ? " other" : "") + (d === t ? " today" : "") + (d === selected ? " sel" : "");
      c.innerHTML = `<span class="n">${Number(d.slice(8))}</span><span class="dots"></span>`;
      const seen = new Set();
      for (const it of (map[d] || []).slice(0, 6)) {
        const dot = document.createElement("span"); dot.className = "dot"; dot.style.setProperty("--c", person(it.e.who).color);
        if (!seen.has(it.e.id)) { seen.add(it.e.id); c.querySelector(".dots").append(dot); }
      }
      if ((map[d] || []).some(it => it.clash.length)) c.classList.add("has-clash");
      c.onclick = () => { selected = d; if (d.slice(0, 7) !== cursor) cursor = d.slice(0, 7); renderMonth(); };
      grid.append(c);
    }
    const det = $("day-detail"); det.innerHTML = "";
    const h = document.createElement("div"); h.className = "day-head" + (selected === t ? " today" : ""); h.textContent = fmtDay(selected);
    det.append(h);
    const dayMap = buildDays(events, selected, selected)[selected] || [];
    if (!dayMap.length) { const e = document.createElement("div"); e.className = "empty"; e.style.padding = "20px"; e.textContent = "Nothing planned."; det.append(e); }
    det.append(...dayMap.map(eventButton));
  }

  // Bottom tabs: each person's own schedule, plus "Together" which merges both
  const tabTitle = () => filter === "all" ? "Together" : `${person(filter).name}'s schedule`;
  function renderTabs() {
    const el = $("tabs"); if (!el) return; el.innerHTML = "";
    const solo = PEOPLE.filter(p => p.id !== "both");
    const both = PEOPLE.find(p => p.id === "both") || { color: "#8b5cf6" };
    const opts = [solo[0], { id: "all", name: "Together", color: both.color, together: true }, solo[1], { id: "todo", name: "To-do", todo: true }, { id: "ai", name: "Ask", ai: true }].filter(Boolean);
    for (const o of opts) {
      const b = document.createElement("button"); b.className = "tab" + (filter === o.id ? " on" : "");
      b.style.setProperty("--c", o.color);
      b.innerHTML = o.together
        ? `<span class="tab-icon pair">${solo.map(p => `<span class="dot" style="--c:${p.color}"></span>`).join("")}</span>`
        : o.todo ? `<span class="tab-icon check">✓</span>`
        : o.ai ? `<span class="tab-icon check">✦</span>`
        : `<span class="tab-icon"><span class="dot"></span></span>`;
      const label = document.createElement("span"); label.className = "tab-label"; label.textContent = o.name; b.append(label);
      b.onclick = () => { filter = o.id; LS.set("filter", filter); renderTabs(); render(); window.scrollTo(0, o.ai ? document.body.scrollHeight : 0); if (o.ai) loadChat(); };
      el.append(b);
    }
  }

  function render() {
    const ai = filter === "ai";
    const todo = filter === "todo" || ai;
    $("todo-view").classList.toggle("hidden", filter !== "todo");
    $("ai-view").classList.toggle("hidden", !ai);
    $("ai-new").classList.toggle("hidden", !ai);
    $("sync").classList.toggle("hidden", ai);
    $("view-row").classList.toggle("hidden", todo);
    $("add").classList.toggle("hidden", todo);
    if (ai) {
      $("list-view").classList.add("hidden"); $("month-view").classList.add("hidden");
      $("prev").disabled = $("next").disabled = true;
      $("title").textContent = "Assistant"; renderChat(false); return;
    }
    if (todo) {
      $("list-view").classList.add("hidden"); $("month-view").classList.add("hidden");
      $("prev").disabled = $("next").disabled = true;
      $("title").textContent = "To-do list"; renderTodos(); return;
    }
    $("list-view").classList.toggle("hidden", view !== "list");
    $("month-view").classList.toggle("hidden", view !== "month");
    [...$("view-seg").children].forEach(b => b.classList.toggle("on", b.dataset.view === view));
    $("prev").disabled = $("next").disabled = view !== "month";
    if (view === "list") { $("title").textContent = tabTitle(); renderList(); } else renderMonth();
  }

  // ---------- to-do list ----------
  // To-dos live in the same events table so no extra database setup is needed:
  // repeat = "todo", title = the task, start/end_time = time slot, notes = "done" when ticked.
  function renderTodos() {
    const el = $("todo-list"); el.innerHTML = "";
    const todos = events.filter(e => e.repeat === "todo");
    const byTime = (a, b) => (a.start_time || "99").localeCompare(b.start_time || "99") || (a.created_at || "").localeCompare(b.created_at || "");
    const open = todos.filter(t => t.notes !== "done").sort(byTime);
    const done = todos.filter(t => t.notes === "done").sort(byTime);
    if (!todos.length) { el.innerHTML = `<div class="empty">Nothing on the list yet.<br>Add what you're up to above.</div>`; return; }
    const row = t => {
      const r = document.createElement("div"); r.className = "todo" + (t.notes === "done" ? " done" : "");
      r.style.setProperty("--c", person(t.created_by || t.who).color);
      r.innerHTML = `<button class="tick" aria-label="Done"></button><span class="todo-time"></span><span class="todo-text"></span><button class="todo-del" aria-label="Delete">×</button>`;
      r.querySelector(".todo-time").textContent = t.start_time ? fmtTime(t.start_time) + (t.end_time ? "–" + fmtTime(t.end_time) : "") : "";
      r.querySelector(".todo-text").textContent = t.title;
      r.querySelector(".tick").onclick = () => saveTodo({ ...t, notes: t.notes === "done" ? null : "done" });
      r.querySelector(".todo-del").onclick = () => removeTodo(t);
      return r;
    };
    el.append(...open.map(row));
    if (done.length) {
      const h = document.createElement("div"); h.className = "day-head todo-done-head"; h.textContent = `Done (${done.length})`;
      const clr = document.createElement("button"); clr.className = "link"; clr.textContent = "Clear";
      clr.onclick = async () => { for (const t of done) await removeTodo(t, true); toast("Cleared"); };
      h.append(clr); el.append(h, ...done.map(row));
    }
  }
  async function saveTodo(t) {
    const tmpId = t.id || "tmp-" + Math.random();
    events = events.filter(x => x.id !== tmpId).concat({ ...t, id: tmpId }); render();
    try {
      const saved = normalize(await api.save(t));
      events = events.filter(x => x.id !== tmpId).concat(saved); LS.set("events", events); render();
    } catch { toast("Couldn't save. Check your connection."); refresh(); }
  }
  async function removeTodo(t, quiet) {
    events = events.filter(x => x.id !== t.id); render();
    try { await api.remove(t.id); LS.set("events", events); }
    catch { if (!quiet) toast("Couldn't delete. Try again."); refresh(); }
  }
  $("todo-form").onsubmit = ev => {
    ev.preventDefault();
    const text = $("todo-text").value.trim(); if (!text) return;
    const start = $("todo-start").value || null, end = start && $("todo-end").value > start ? $("todo-end").value : null;
    saveTodo({ title: text, date: todayS(), start_time: start, end_time: end, repeat: "todo", who: me || "both", created_by: me, notes: null });
    notifyOther("change", `${person(me).name} added a to-do`, text + (start ? ` · ${fmtTime(start)}` : ""));
    $("todo-text").value = ""; $("todo-start").value = ""; $("todo-end").value = "";
    $("todo-text").focus();
  };

  // ---------- Shared AI assistant: one conversation, sub-chats Together / Daniel / Julie ----------
  // Messages live in Supabase (chat_messages) so both phones see every sub-chat.
  let chatMsgs = LS.get("chat.cache", []);
  let chatThread = LS.get("chat.thread", null);
  let thinking = null; // thread currently waiting for a reply
  let chatLoading = false;
  const escapeHtml = s => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const formatAi = s => escapeHtml(s).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/\n/g, "<br>");
  const threads = () => [{ id: "together", name: "Together" }, ...PEOPLE.filter(p => p.id !== "both")];
  async function loadChat(full) {
    if (!REMOTE || chatLoading) return;
    chatLoading = true;
    try {
      const since = !full && chatMsgs.length ? chatMsgs[chatMsgs.length - 1].created_at : null;
      const fresh = await rpc("list_chat", since ? { p_since: since } : {});
      const before = chatMsgs.length;
      chatMsgs = full ? fresh : chatMsgs.concat(fresh.filter(m => !chatMsgs.some(x => x.id === m.id)));
      LS.set("chat.cache", chatMsgs.slice(-600));
      if (filter === "ai" && (full || chatMsgs.length !== before)) renderChat();
    } catch (err) { if (!err.badCode && filter === "ai" && full) toast("Couldn't load the chat. Run supabase-chat.sql in Supabase?"); }
    finally { chatLoading = false; }
  }
  function renderChat(scroll = true) {
    chatThread ||= me || "together";
    document.querySelector(".ai-head").style.top = document.querySelector(".top").offsetHeight + "px";
    segButtons($("ai-threads"), threads().map(t => ({ ...t, color: person(t.id === "together" ? "both" : t.id).color })), chatThread, id => {
      chatThread = id; LS.set("chat.thread", id); renderChat();
    });
    const mine = chatThread === "together" || chatThread === me;
    $("ai-form").classList.toggle("hidden", !mine);
    $("ai-readonly").classList.toggle("hidden", mine);
    $("ai-readonly").textContent = mine ? "" : `This is ${person(chatThread).name}'s chat. You can read it; only ${person(chatThread).name} can write here.`;
    $("ai-new").classList.toggle("hidden", !mine);
    const log = $("ai-log"); log.innerHTML = "";
    const list = chatMsgs.filter(m => m.thread === chatThread);
    if (!list.length) {
      const who = chatThread === "together" ? "both of you" : person(chatThread).name;
      log.innerHTML = `<div class="empty">This is the chat for ${escapeHtml(who)}. 🍂<br>Try <i>"When are we both free this week?"</i><br>or <i>"What did Julie ask you about?"</i></div>`;
    }
    for (const m of list) {
      const b = document.createElement("div");
      if (m.author === "ai") { b.className = "bubble bot"; b.innerHTML = formatAi(m.content); }
      else {
        b.className = "bubble me" + (m.author !== me ? " other" : "");
        b.style.setProperty("--c", person(m.author).color);
        if (chatThread === "together" || m.author !== me) { const n = document.createElement("div"); n.className = "bubble-name"; n.textContent = person(m.author).name; b.append(n); }
        b.append(document.createTextNode(m.content));
      }
      if (m.error) { b.classList.add("err"); b.append(document.createElement("br"), Object.assign(document.createElement("b"), { textContent: "Tap to try again" })); b.onclick = () => { if (!thinking) askAi(m.thread); }; }
      log.append(b);
    }
    if (thinking === chatThread) { const t = document.createElement("div"); t.className = "bubble bot typing"; t.innerHTML = "<span></span><span></span><span></span>"; log.append(t); }
    if (scroll) requestAnimationFrame(() => window.scrollTo(0, document.body.scrollHeight));
  }
  async function sendChat(text) {
    if (!REMOTE) { toast("The assistant needs the shared database connected."); return; }
    const thread = chatThread;
    chatMsgs = chatMsgs.filter(m => !m.error);
    try {
      const saved = await rpc("add_chat", { p_thread: thread, p_author: me, p_content: text });
      chatMsgs.push(saved);
      if (thread === "together") notifyOther("chat", `${person(me).name} in the Together chat`, text.slice(0, 140));
    } catch (err) {
      toast(err.badCode ? "Wrong passcode." : "Couldn't send. Run supabase-chat.sql in Supabase?"); return;
    }
    askAi(thread);
  }
  async function askAi(thread) {
    chatMsgs = chatMsgs.filter(m => !m.error);
    thinking = thread; renderChat();
    const n = new Date();
    try {
      const res = await fetch(`${CFG.supabaseUrl.replace(/\/$/, "")}/functions/v1/${CFG.aiFunction || "ai-chat"}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: CFG.supabaseAnonKey },
        body: JSON.stringify({
          code, person: me, thread, today: todayS() + " (" + n.toLocaleDateString(undefined, { weekday: "long" }) + ")",
          now: n.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
          people: Object.fromEntries(PEOPLE.map(p => [p.id, p.name])),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.message) throw new Error(data.error || (res.status === 404 ? "The assistant isn't set up in Supabase yet." : `Error ${res.status}`));
      if (!chatMsgs.some(x => x.id && x.id === data.message.id)) chatMsgs.push(data.message);
    } catch (err) {
      chatMsgs.push({ thread, author: "ai", content: "⚠ " + (err.message === "Failed to fetch" ? "Couldn't reach the assistant. Check your connection." : err.message), error: true });
    }
    LS.set("chat.cache", chatMsgs.filter(m => !m.error).slice(-600)); thinking = null;
    if (filter === "ai") renderChat();
  }
  const aiInput = $("ai-input");
  const growInput = () => { aiInput.style.height = "auto"; aiInput.style.height = Math.min(aiInput.scrollHeight, 140) + "px"; };
  aiInput.addEventListener("input", growInput);
  $("ai-form").onsubmit = ev => {
    ev.preventDefault();
    const text = aiInput.value.trim(); if (!text || thinking) return;
    aiInput.value = ""; growInput(); sendChat(text);
  };
  $("ai-new").onclick = async () => {
    if (thinking) return;
    const name = chatThread === "together" ? "the Together chat" : "your chat";
    if (!confirm(`Clear ${name}? This deletes it for both of you.`)) return;
    try { await rpc("clear_chat", { p_thread: chatThread }); chatMsgs = chatMsgs.filter(m => m.thread !== chatThread); LS.set("chat.cache", chatMsgs); renderChat(); }
    catch { toast("Couldn't clear. Try again."); }
  };

  // ---------- notifications ----------
  const notifyUrl = () => `${CFG.supabaseUrl.replace(/\/$/, "")}/functions/v1/notify`;
  function notifyOther(type, title, text, extra = {}) {
    if (!REMOTE) return;
    fetch(notifyUrl(), { method: "POST", headers: { "Content-Type": "application/json", apikey: CFG.supabaseAnonKey },
      body: JSON.stringify({ code, type, from: me, title, text, ...extra }) }).catch(() => {});
  }
  function describeEvent(e) {
    const d = toD(e.date).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
    return `${d}${e.start_time ? " at " + fmtTime(e.start_time) : ""} · ${person(e.who).name}`;
  }
  const isIos = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const standalone = window.navigator.standalone || matchMedia("(display-mode: standalone)").matches;
  const b64ToBytes = s => { const b = atob((s + "===".slice((s.length + 3) % 4)).replace(/-/g, "+").replace(/_/g, "/")); return Uint8Array.from(b, c => c.charCodeAt(0)); };
  async function pushSub() {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) return null;
    const reg = await navigator.serviceWorker.ready;
    return reg.pushManager.getSubscription();
  }
  async function updateBell() {
    const sub = await pushSub().catch(() => null);
    $("bell").textContent = sub && Notification.permission === "granted" ? "🔔" : "🔕";
  }
  $("bell").onclick = async () => {
    if (!REMOTE) { toast("Notifications need the shared database connected."); return; }
    if (!("PushManager" in window) || !("Notification" in window)) {
      toast(isIos && !standalone ? "Open the app from your Home Screen first, then tap the bell." : "This browser doesn't support notifications."); return;
    }
    try {
      const existing = await pushSub();
      if (existing && Notification.permission === "granted") { openNotifSheet(); return; }
      const perm = await Notification.requestPermission();
      if (perm !== "granted") { toast("Notifications are blocked. Turn them on in Settings → Notifications → Our Schedule."); return; }
      let step = "subscribe";
      try {
        const reg = await navigator.serviceWorker.ready;
        const sub = existing || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(CFG.vapidPublicKey) });
        step = "save";
        await savePush(sub);
        step = "test";
        const res = await fetch(notifyUrl(), { method: "POST", headers: { "Content-Type": "application/json", apikey: CFG.supabaseAnonKey },
          body: JSON.stringify({ code, type: "test", from: me, title: "Notifications are on 🍂", text: "You'll get reminders and a heads-up when things change.", endpoint: sub.endpoint }) });
        const data = await res.json().catch(() => ({}));
        updateBell();
        if (!res.ok) toast(res.status === 404 ? "Almost: the 'notify' function isn't deployed in Supabase yet." : "Almost: " + (data.error || data.message || `notify error ${res.status}`));
        else if (!data.sent) toast("Saved, but the test notification didn't go through. Check the VAPID secrets in Supabase.");
        else { toast("Notifications on"); openNotifSheet(); }
      } catch (err) {
        updateBell();
        const msg = step === "save" ? (err.badCode ? "Wrong passcode." : "Couldn't save. Run supabase-notify.sql in Supabase first.")
          : step === "subscribe" ? "Your phone refused: " + (err.message || err.name)
          : "Couldn't reach the notify function: " + (err.message || err.name);
        toast(msg);
      }
    } catch (err) {
      toast("Couldn't turn on notifications: " + (err.message || err.name));
    }
  };
  updateBell();

  // Reminder options are stored with this phone's subscription (sub.prefs), read by the notify function.
  const defaultPrefs = { r1440: false, r60: true, r5: false, r1: false };
  const getPrefs = () => ({ ...defaultPrefs, ...LS.get("notif.prefs", {}) });
  async function savePush(sub) {
    await rpc("save_push", { p_person: me, p_sub: { ...sub.toJSON(), prefs: getPrefs() }, p_tz: Intl.DateTimeFormat().resolvedOptions().timeZone });
  }
  function openNotifSheet() {
    const prefs = getPrefs();
    document.querySelectorAll("#nsheet [data-pref]").forEach(el => { el.checked = !!prefs[el.dataset.pref]; });
    $("nsheet").classList.remove("hidden"); $("nsheet-bg").classList.remove("hidden");
  }
  function closeNotifSheet() { $("nsheet").classList.add("hidden"); $("nsheet-bg").classList.add("hidden"); }
  $("nsheet-done").onclick = closeNotifSheet;
  $("nsheet-bg").onclick = closeNotifSheet;
  document.querySelectorAll("#nsheet [data-pref]").forEach(el => el.onchange = async () => {
    LS.set("notif.prefs", { ...getPrefs(), [el.dataset.pref]: el.checked });
    try { const sub = await pushSub(); if (sub) await savePush(sub); }
    catch { el.checked = !el.checked; LS.set("notif.prefs", { ...getPrefs(), [el.dataset.pref]: el.checked }); toast("Couldn't save that. Check your connection."); }
  });
  $("notif-off").onclick = async () => {
    if (!confirm("Turn off notifications on this phone?")) return;
    const sub = await pushSub().catch(() => null);
    if (sub) { await rpc("delete_push", { p_endpoint: sub.endpoint }).catch(() => {}); await sub.unsubscribe().catch(() => {}); }
    closeNotifSheet(); updateBell(); toast("Notifications off");
  };

  // ---------- editor ----------
  let editing = null, formWho = "both";
  function openSheet(e, occStart) {
    editing = e || null;
    $("sheet-title").textContent = e ? "Edit event" : "New event";
    $("f-title").value = e ? e.title : "";
    formWho = e ? e.who : (filter !== "all" ? filter : "both");
    segButtons($("f-who"), PEOPLE, formWho, id => formWho = id);
    $("f-date").value = e ? e.date : (view === "month" ? selected : todayS());
    $("f-allday").checked = e ? !e.start_time : false;
    $("f-start").value = e ? (e.start_time || "") : "";
    $("f-end").value = e ? (e.end_time || "") : "";
    $("f-enddate").value = e ? (e.end_date || "") : "";
    $("f-repeat").value = e ? (e.repeat || "none") : "none";
    $("f-location").value = e ? (e.location || "") : "";
    $("f-notes").value = e ? (e.notes || "") : "";
    $("delete").classList.toggle("hidden", !e);
    $("f-meta").textContent = e && e.created_by ? `Added by ${person(e.created_by).name}` : "";
    syncFormBits();
    $("sheet").classList.remove("hidden"); $("sheet-bg").classList.remove("hidden");
    $("sheet").querySelector(".sheet-body").scrollTop = 0;
    if (!e) setTimeout(() => $("f-title").focus(), 50);
  }
  function closeSheet() { $("sheet").classList.add("hidden"); $("sheet-bg").classList.add("hidden"); editing = null; document.activeElement?.blur(); }
  function syncFormBits() {
    $("times").classList.toggle("hidden", $("f-allday").checked);
    $("repeat-note").classList.toggle("hidden", !(editing && $("f-repeat").value !== "none"));
  }
  $("f-allday").onchange = syncFormBits;
  $("f-repeat").onchange = syncFormBits;
  $("f-start").onchange = () => {
    // Default end = start + 1h, if empty or before start
    const s = $("f-start").value; if (!s) return;
    if (!$("f-end").value || $("f-end").value <= s) { const [h, m] = s.split(":").map(Number); if (h < 23) $("f-end").value = `${pad(h + 1)}:${pad(m)}`; }
  };
  $("cancel").onclick = closeSheet;
  $("sheet-bg").onclick = closeSheet;

  $("sheet").onsubmit = async ev => {
    ev.preventDefault();
    const allDay = $("f-allday").checked;
    const e = {
      id: editing ? editing.id : undefined,
      title: $("f-title").value.trim(),
      who: formWho,
      date: $("f-date").value,
      end_date: $("f-enddate").value && $("f-enddate").value > $("f-date").value ? $("f-enddate").value : null,
      start_time: allDay ? null : ($("f-start").value || null),
      end_time: allDay ? null : ($("f-end").value || null),
      repeat: $("f-repeat").value,
      location: $("f-location").value.trim() || null,
      notes: $("f-notes").value.trim() || null,
      created_by: editing ? editing.created_by : me,
    };
    if (!e.title || !e.date) return;
    if (!e.start_time) e.end_time = null;
    const wasEditing = !!editing;
    closeSheet();
    // optimistic update
    const tmpId = e.id || "tmp-" + Math.random();
    events = events.filter(x => x.id !== tmpId).concat({ ...e, id: tmpId });
    render();
    try {
      setSync("busy");
      const saved = normalize(await api.save(e));
      events = events.filter(x => x.id !== tmpId).concat(saved);
      LS.set("events", events); setSync(REMOTE ? "" : "off"); render();
      toast(wasEditing ? "Saved" : "Added ✓");
      notifyOther("change", `${person(me).name} ${wasEditing ? "updated" : "added"} ${saved.title}`, describeEvent(saved));
    } catch (err) {
      setSync("err"); toast("Couldn't save. Check your connection and try again."); refresh();
    }
  };

  $("delete").onclick = async () => {
    if (!editing) return;
    const e = editing;
    const msg = e.repeat && e.repeat !== "none" ? `Delete "${e.title}" and all its repeats?` : `Delete "${e.title}"?`;
    if (!confirm(msg)) return;
    closeSheet();
    events = events.filter(x => x.id !== e.id); render();
    try { await api.remove(e.id); LS.set("events", events); toast("Deleted"); notifyOther("change", `${person(me).name} removed ${e.title}`, describeEvent(e)); }
    catch { toast("Couldn't delete. Try again."); refresh(); }
  };

  // ---------- nav ----------
  $("view-seg").onclick = ev => { const v = ev.target.closest("button")?.dataset.view; if (v) { view = v; LS.set("view", v); render(); } };
  const shiftMonth = n => { let [y, m] = cursor.split("-").map(Number); m += n; if (m < 1) { m = 12; y--; } if (m > 12) { m = 1; y++; } cursor = `${y}-${pad(m)}`; render(); };
  $("prev").onclick = () => shiftMonth(-1);
  $("next").onclick = () => shiftMonth(1);
  $("add").onclick = () => openSheet(null);
  // swipe between months
  let sx = null, sy = null;
  $("month-view").addEventListener("touchstart", e => { sx = e.touches[0].clientX; sy = e.touches[0].clientY; }, { passive: true });
  $("month-view").addEventListener("touchend", e => {
    if (sx == null) return;
    const dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy; sx = null;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) shiftMonth(dx < 0 ? 1 : -1);
  }, { passive: true });
  $("title").onclick = () => { if (view === "month") { cursor = todayS().slice(0, 7); selected = todayS(); render(); } };

  // ---------- setup ----------
  let setupWho = me;
  function showSetup(error) {
    $("app").classList.add("hidden"); $("setup").classList.remove("hidden");
    segButtons($("setup-who"), PEOPLE.filter(p => p.id !== "both"), setupWho, id => setupWho = id);
    $("code-wrap").classList.toggle("hidden", !REMOTE);
    $("demo-note").classList.toggle("hidden", REMOTE);
    $("setup-code").value = code || "";
    $("setup-error").textContent = error || "";
  }
  $("setup-go").onclick = async () => {
    if (!setupWho) { $("setup-error").textContent = "Pick who you are first."; return; }
    code = $("setup-code").value.trim();
    if (REMOTE && !code) { $("setup-error").textContent = "Enter the passcode."; return; }
    $("setup-go").disabled = true; $("setup-error").textContent = "";
    try {
      if (REMOTE) events = (await rpc("list_events", {})).map(normalize);
      me = setupWho; LS.set("me", me); LS.set("code", code); LS.set("events", events);
      startApp();
    } catch (err) {
      $("setup-error").textContent = err.badCode ? "That passcode didn't work." : "Couldn't connect. Check your internet and try again.";
    } finally { $("setup-go").disabled = false; }
  };
  $("setup-code").addEventListener("keydown", e => { if (e.key === "Enter") $("setup-go").click(); });

  let timer = null;
  function startApp() {
    $("setup").classList.add("hidden"); $("app").classList.remove("hidden");
    setSync(REMOTE ? "" : "off");
    renderTabs(); render(); refresh();
    clearInterval(timer); timer = setInterval(() => { if (document.visibilityState === "visible") refresh(); }, 20000);
  }
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") { if (selected < todayS() && view === "list") render(); refresh(); } });
  window.addEventListener("online", refresh);
  $("sync").onclick = () => { if (REMOTE) { toast("Syncing…"); refresh(); } else toast("Demo mode: saved on this device only"); };
  // Long-press title to switch user / passcode
  let lp; $("title").addEventListener("touchstart", () => lp = setTimeout(() => showSetup(), 800), { passive: true });
  $("title").addEventListener("touchend", () => clearTimeout(lp));
  $("title").addEventListener("dblclick", () => showSetup());

  // No zooming: block pinch (Safari ignores user-scalable=no); CSS touch-action stops double-tap zoom
  ["gesturestart", "gesturechange"].forEach(t => document.addEventListener(t, e => e.preventDefault(), { passive: false }));

  if (me && (!REMOTE || code)) startApp(); else showSetup();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

  window.__schedule = { occurrences }; // for tests
})();
