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
