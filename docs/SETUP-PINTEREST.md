# Pinterest setup

One Pinterest app serves every Pinterest account. Each account signs in on its own.

## 1. Create the app

1. Log in to Pinterest with a **business** account.
2. <https://developers.pinterest.com/apps/> → **Connect app**. Give a name, a short
   description of what the tool does, a website and a privacy policy URL that you control.
3. Pinterest reviews it (usually a few days) and gives it **Trial access**.
4. In the app, copy the **App ID** and **App secret key**. Under **Redirect URIs** add
   `http://localhost:8585/callback`.
5. Put them in `~/.config/social-publisher/apps.json` under `"pinterest"`.

## 2. Trial vs Standard access

- **Trial**: Pinterest refuses Pins in production. You can test the whole flow against
  Pinterest's sandbox with `"sandbox": true` in `apps.json` (a sandbox sign-in is separate).
- **Standard** (public Pins): in the app, ask for the **Upgrade**. Pinterest wants a short screen
  recording: the sign-in, then a Pin being created with the tool. Approval can take a while.
- After the upgrade, set `"sandbox": false` and sign in again.

## 3. Sign in each account

Log in to Pinterest in your browser as the right account first, then:

```sh
social auth pinterest --brand example
social accounts pinterest        # lists every board with its id
```

Put `username` and `defaultBoard` in the brand file. A board can be given by name, by id, or
by a short alias from the brand's `"boards"` map.

## Notes

- The sign-in renews itself (the refresh token is extended on each use). With the cloud
  scheduler, the Worker renews it.
- The API has no "AI-modified" switch. For brands with `aiDisclosure`, the tool adds that line
  to the description.
- Pinterest has no scheduling in its API. Scheduled Pins go through the cloud scheduler (or the
  local queue).
