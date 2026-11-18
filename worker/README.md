# Live data relay (Cloudflare Worker)

PATH's live departure feed doesn't allow other websites to read it, so the
GitHub Pages version of the board can't use it directly. This tiny Worker
fetches it and passes it on. It runs on Cloudflare's free plan.

## Set it up (about 5 minutes)

1. Create a free account at https://dash.cloudflare.com/sign-up.
2. In the dashboard, open **Workers & Pages**, then **Create**, then
   **Create Worker**. Name it `penn-board-relay` and click **Deploy**.
3. Click **Edit code**, delete what's there, paste in the whole of
   `worker/worker.js`, and click **Deploy**.
4. Copy the Worker's address, which looks like
   `https://penn-board-relay.<your-name>.workers.dev`.
5. In this repository, open `docs/config.js` and put that address between the
   quotes:

   ```js
   window.PENN_RELAY = 'https://penn-board-relay.<your-name>.workers.dev';
   ```

6. Commit the change. The board picks up live PATH times within a minute or two
   of GitHub Pages updating.

To check the Worker on its own, open `<your address>/path` in a browser: it
should show PATH's live data.

## Cost and limits

The free plan allows 100,000 requests a day. The board asks once every 20
seconds per open page, so that's about 4,300 requests a day for each page left
open all day. Cloudflare caches PATH's feed for 15 seconds, so PATH itself is
asked far less.

The same Worker can carry NJ Transit later, with the login kept as a Worker
secret rather than in the public page.
