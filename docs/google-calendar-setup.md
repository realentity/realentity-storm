# Google Calendar for Storm: setup

Connects your Google Calendar so pipelines can read your events (`calendar.find`) and propose new ones
(`calendar.create`, always waiting for your approval). It's done once and takes about 15 minutes. You need the Google
account whose calendar Storm should use, and access to Storm's `.env` on your server ([self-hosting.md](self-hosting.md)).

What you create: a Google Cloud **project**, with the **Calendar API** turned on, a **consent screen** (what Google
shows when you sign in), and an **OAuth client** (an id and a secret that Storm puts in `.env`).

> Google renames buttons in its console now and then. If a label differs, look for the same idea nearby; the
> addresses below take you to the right page.

---

## 1. Create the project

1. Open <https://console.cloud.google.com/> and sign in with your Google account.
2. If Google asks you to accept the Terms of Service, accept them.
3. Open <https://console.cloud.google.com/projectcreate>.
4. **Project name:** `realentity-storm`. Leave **Location** as it is (*No organization*).
5. Press **Create** and wait a few seconds.
6. Make sure the project picker at the top of the page shows **realentity-storm**. If it doesn't, click it and choose `realentity-storm`.
   Every step below happens in this project.

## 2. Turn on the Google Calendar API

1. Open <https://console.cloud.google.com/apis/library/calendar-json.googleapis.com> (the project picker still shows
   `realentity-storm`).
2. Press **Enable**.

## 3. The consent screen (Google Auth Platform)

1. Open <https://console.cloud.google.com/auth/overview>.
2. Press **Get started**, and fill in:
   - **App information:** **App name** `Storm`; **User support email**: your Gmail address. Press **Next**.
   - **Audience:** **External** (with a personal Gmail account it's the only choice). **Next**.
   - **Contact information:** your Gmail address. **Next**.
   - **Finish:** tick that you agree to the Google API Services User Data Policy, then **Continue** and **Create**.

### Scopes (what Storm may do)

1. In the left menu, open **Data access**.
2. Press **Add or remove scopes**.
3. Tick these three (type each in the filter box to find it):
   - `openid`
   - `.../auth/userinfo.email`: your address, so Settings can show which account is connected.
   - `.../auth/calendar.events`: "View and edit events on all your calendars".
4. Press **Update**, then **Save** at the bottom of the page.

### You as the test user

The app stays in **Testing** (Google publishes an External app only with a homepage and a privacy policy page: see
[Later: In production](#later-in-production)). In Testing, only the accounts listed as test users may sign in.

1. In the left menu, open **Audience**. **Publishing status** says **Testing**: leave it.
2. Under **Test users**, press **Add users**, enter your Gmail address, **Save**.

In Testing, Google ends the connection **7 days** after you connect. Storm handles that: the next run that needs the
calendar waits for you, and Telegram says **Google Calendar needs reconnecting** with a **Reconnect** button (a
sign-in, about 20 seconds); the run goes on once you're back.

## 4. The OAuth client (the id and secret for Storm)

1. In the left menu, open **Clients**, and press **Create client**.
2. **Application type:** **Web application**.
3. **Name:** `storm`.
4. **Authorized JavaScript origins:** leave empty.
5. **Authorized redirect URIs** → **Add URI**:

   ```
   https://storm.example.com/api/google/callback
   ```

   That is your `APP_ORIGIN` followed by `/api/google/callback`. It must match exactly: `https`, the same host and
   port, no slash at the end. Storm's **Settings → Google Calendar** shows the address it uses, if you want to
   compare.
6. Press **Create**.
7. A dialog shows the **Client ID** (ends in `.apps.googleusercontent.com`) and the **Client secret** (starts with
   `GOCSPX-`). **Copy both now, or press Download JSON**: Google may not show the secret again. (If you lose it: open
   the client, **Add secret**, and use the new one.)

## 5. Put them in Storm's `.env`

On the server, in Storm's folder (the repository's root):

```sh
nano .env
```

Fill in these two lines (they are already in the file, empty, if it was made from `.env.example`; otherwise add them
at the end):

```sh
GOOGLE_CLIENT_ID=123456789012-abcdefghijklmnop.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-xxxxxxxxxxxxxxxxxxxxxxxx
```

Save (Ctrl+O, Enter, Ctrl+X), then restart Storm so it reads them:

```sh
./docker/storm up
```

Check that it started: `./docker/storm ps` shows `api` and `worker` running. If `api` keeps restarting, its log says
which key is wrong (`./docker/storm logs api`; it names the key, never the value).

## 6. Connect in Storm

1. Open Storm's **Settings** (`APP_ORIGIN` + `/settings`). The **Google Calendar** card now has
   **Connect Google Calendar** (it said *Not set up* before step 5).
2. Press it. Google's sign-in opens: choose your account.
3. Google says **"Google hasn't verified this app"**. That's your own app (step 3): press **Continue** (or
   **Advanced**, then **Go to Storm (unsafe)**).
4. Google lists what Storm asks for. **Tick the calendar access** ("See, edit, share, and permanently delete all the
   calendars…" or "View and edit events…"), then **Continue**.
5. You're back on Settings: a green message **Google Calendar connected**, and the card says
   **Connected as you@gmail.com**.

Done. Pipelines with calendar steps can now run; the review screen no longer warns about the calendar.

---

## Later

- **"Google Calendar needs reconnecting"** (Telegram, or the card shows it in red): the connection was ended, in
  Testing every 7 days (or you removed Storm's access, or changed something in Google's security settings). Press
  **Reconnect Google Calendar** in the message or on Settings and sign in again. A run that was waiting goes on by
  itself.
- **To stop Storm using your calendar:** Settings → **Disconnect** (Storm forgets the token), and remove **Storm** at
  <https://myaccount.google.com/permissions> (Google forgets the access).
- **A new client secret:** Google Cloud → **Clients** → `storm` → **Add secret**, put it in `.env`,
  `./docker/storm up`, then disable the old secret there.

## Later: In production

To stop the weekly reconnect, publish the app. Google asks for two public pages first:

1. A **homepage** and a **privacy policy** page on a domain you own (e.g. `example.com`; not `hooks.example.com`, which
   only Telegram and webhook callers can reach). A few lines each are enough: Storm is a personal assistant used only
   by you; it reads and creates events in your own calendar; it shares nothing with anyone.
2. **Branding:** fill in **Application home page** and **Application privacy policy link**, and add the domain under
   **Authorized domains**. **Save**. (If Google asks you to verify the domain, do it in Google Search Console with
   a DNS record.)
3. **Audience → Publish app → Confirm**: **In production**. Skip verification: for you alone, an unverified app works.
4. In Storm, **Settings → Reconnect** once. From then on, the connection lasts until you remove it.

## If something goes wrong

| What you see | What to do |
|---|---|
| Settings: **Not set up** | `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` aren't in `.env`, or Storm wasn't restarted (step 5) |
| Google: **Error 400: redirect_uri_mismatch** | the redirect URI of the client (step 4.5) isn't exactly the one Settings shows: fix it in **Clients → storm**, wait a minute, connect again |
| Google: **Error 403: access_denied**, "has not completed the Google verification process" | your account isn't a test user: add it (step 3, *You as the test user*) |
| Google: **invalid_client** | the client id or secret in `.env` is wrong or has a space: copy them again, restart |
| Back on Settings: **the calendar wasn't allowed** | on Google's list (step 6.4) the calendar box wasn't ticked: connect again and tick it |
| Back on Settings: **Google sent no refresh token** | remove Storm at <https://myaccount.google.com/permissions>, then connect again |
| Back on Settings: **the sign-in expired or wasn't started here** | more than 10 minutes passed, or Storm restarted meanwhile: press Connect again |
| **Google Calendar API has not been used in project … or it is disabled** (in a run's error) | step 2 was done in another project: enable the Calendar API in `realentity-storm` |
| The connection ends every week | that's Testing: reconnect when asked, or publish the app ([Later: In production](#later-in-production)) |
