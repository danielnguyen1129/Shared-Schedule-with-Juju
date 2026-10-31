# Our Schedule

A tiny shared calendar for two, built to live on your iPhone home screen.

- **Upcoming** list and **Month** calendar, colour-coded by person (Daniel / Julie / Both)
- Times or all-day, multi-day trips, repeats (daily, weekly, every 2 weeks, monthly, yearly), location and notes
- Changes sync between phones (refreshes when you open the app and every 20 seconds)
- Protected by a shared passcode

## Setup (one time)
1. **Supabase**: create a free project → SQL Editor → paste `supabase.sql`, change `CHANGE-ME` to your passcode → Run.
2. Put your Project URL and anon/publishable key in `config.js`.
3. **GitHub Pages**: repo Settings → Pages → Deploy from branch `main`, folder `/ (root)`.

## Install on iPhone
Open the site in Safari → Share button → **Add to Home Screen**.

## Tips
- Press and hold the title to switch person or re-enter the passcode.
- Tap the month name to jump back to today. Swipe left/right to change months.
- To change the passcode later, re-run just the last statement of `supabase.sql` with the new code.

## Ask tab (AI assistant)
One shared assistant with three sub-chats (Together, Daniel, Julie). Both people can read every sub-chat and the assistant remembers across them.
Runs on Google Gemini through the Supabase Edge Function in `supabase/functions/ai-chat/index.ts`.
0. Run `supabase-chat.sql` in the SQL Editor (stores the chats).
1. Supabase → Edge Functions → Deploy a new function → Via Editor → name `ai-chat`, paste the file, Deploy.
2. Edge Functions → Secrets → add `GEMINI_API_KEY` (from aistudio.google.com).
3. Open the `ai-chat` function's settings and turn **off** "Verify JWT" (the passcode protects it).

## Notifications
Reminders: tap the bell to choose 1 day, 1 hour, 5 minutes and/or 1 minute before each event (per phone). All-day events remind at 8am, to-dos at their start time. You also get a heads-up when the other person changes something or writes in the Together chat.
1. Run `supabase-notify.sql` in the SQL Editor (replace `YOUR-PASSCODE` first). It schedules a reminder check every minute.
2. Deploy `supabase/functions/notify/index.ts` as an Edge Function named `notify`, with "Verify JWT" off.
3. Add secrets `VAPID_PUBLIC_KEY` (same as in config.js) and `VAPID_PRIVATE_KEY`.
4. On each iPhone, open the app from the Home Screen and tap the 🔕 bell.
