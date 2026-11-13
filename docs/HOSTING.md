# Putting Poker Night online (Cloudflare, free)

Poker Night runs on Cloudflare's free plan, the same way Family Card Table does. Nothing to keep running, no card needed,
and every change pushed to `main` goes online by itself.

## One-time setup (about 5 minutes if Family Card Table is already set up)

1. In this repository open *Settings > Secrets and variables > Actions > New repository secret* and add:
   - `CLOUDFLARE_API_TOKEN`: a token made from the **Edit Cloudflare Workers** template at
     <https://dash.cloudflare.com/profile/api-tokens> (the Family Card Table token works too)
   - `CLOUDFLARE_ACCOUNT_ID`: shown on the right of *Workers & Pages* in the Cloudflare dashboard
2. Open the *Actions* tab > **Deploy** > *Run workflow*. After about a minute the log ends with an address like
   `https://mattspoker.<your-name>.workers.dev`. That is the game. Send it around or link it from Family Card Table.

Want a nicer address such as `poker.yourname.com`? In the Cloudflare dashboard open the `mattspoker` Worker >
*Settings > Domains & Routes* and add it.

## How games are kept safe

Each game code is its own Cloudflare Durable Object. The table (seats, chips, cards, whose turn it is) is saved after
every single action, so a Cloudflare restart or a new deploy in the middle of a hand carries on exactly where it was,
and everybody's app reconnects by itself. Games nobody has opened for 3 days are deleted.

## Free plan limits

A party of up to ten people uses a small fraction of the free allowance (100,000 requests a day and 100,000 saved
writes a day). The phones' heartbeats are answered without waking the game. While someone is connected the game also
wakes by itself, about once every 35 to 40 seconds, to notice a connection that has gone quiet (roughly 100 wake-ups
an hour); it only saves the table when something changed. With nobody connected it sleeps until the 3-day cleanup.
These numbers are estimates from the code and Cloudflare's published billing rules, not measurements.

## Running it somewhere else

`npm run build && npm start` runs everything as one Node.js program on port 8080 (set `PORT` to change it).
Games are saved in `./data`.
