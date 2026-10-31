// Fill these in from Supabase → Project Settings → API.
// Leave them empty to run in "demo mode" (data saved only on this device).
window.SCHEDULE_CONFIG = {
  supabaseUrl: "https://whcfthvbpomlfbeqvyad.supabase.co",
  supabaseAnonKey: "sb_publishable_xbTpKW2b9SBdZqm4S4XOMg_H06Sp4SM",
  // Public half of the notification key pair (the private half is a Supabase secret).
  vapidPublicKey: "BFfDqEk-MpTO3l61f1B6xhKV8JHzIAzqKuEBUnl9B_3COxAOwC1lb0S8XjADmC2yN9XIyMZi-qTS0VQnreWKzyc",
  people: [
    { id: "daniel", name: "Daniel", color: "#4d7c5a" },
    { id: "juju",   name: "Julie",  color: "#c2416b" },
    { id: "both",   name: "Both",   color: "#d97706" }
  ]
};
