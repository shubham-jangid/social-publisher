# LinkedIn setup

LinkedIn has two ways to post, and they can't share one app:

| | Post as a **company Page** | Post as **your profile** |
|---|---|---|
| LinkedIn product | Community Management API | Share on LinkedIn + Sign In with LinkedIn using OpenID Connect |
| Approval | LinkedIn reviews it; needs a verified business; days to weeks | Instant |
| Scopes | `w_organization_social r_organization_social` | `openid profile w_member_social` |
| Brand `author` | `urn:li:organization:<id>` | `me` |

## 1. Company Page app

1. <https://www.linkedin.com/developers/apps> → **Create app**. Link it to your LinkedIn Page
   (you must be a Page admin and approve the verification request from the Page).
2. **Products** → **Community Management API** → request access. It must be the only product
   on this app. LinkedIn may ask you to verify the business.
3. **Auth** tab: copy the **Client ID** and **Primary Client Secret**. Under **Authorized
   redirect URLs** add `http://localhost:8585/callback`.
4. In `~/.config/social-publisher/apps.json`:
   ```json
   "linkedin": {
     "default": { "clientId": "…", "clientSecret": "…", "version": "202610",
                  "scopes": ["w_organization_social", "r_organization_social"] }
   }
   ```
5. The organization id is in the Page admin address: `linkedin.com/company/<number>/admin/…`.
   Put `urn:li:organization:<number>` in the brand file → `linkedin.author`.
6. `social auth linkedin --brand <brand>`, then `social check <brand>`.

## 2. Personal profile app (instant)

Create a second app with the **Share on LinkedIn** and **Sign In with LinkedIn using OpenID
Connect** products, and add it as another named app:

```json
"linkedin": {
  "default": { … },
  "personal": { "clientId": "…", "clientSecret": "…", "version": "202610",
                "scopes": ["openid", "profile", "w_member_social"] }
}
```

In the brand file: `"linkedin": { "app": "personal", "author": "me" }`. Sign in with
`social auth linkedin --app personal` (or `--brand <brand>`).

## Notes

- Tokens last 60 days. If LinkedIn gives a refresh token, the tool (and the Worker) renews it.
  If not, `social check` and the Worker's alerts warn you two weeks ahead: sign in again, then
  `social cloud push`.
- `version` is LinkedIn's monthly API version (YYYYMM). Each one works for about a year. When
  LinkedIn retires a version, change it in `apps.json`.
- LinkedIn has no scheduling in its API. Scheduled posts go through the cloud scheduler (or the
  local queue).
- The calendar lists LinkedIn posts this tool scheduled, but it cannot read posts made
  elsewhere on LinkedIn, and there are no LinkedIn numbers in the analytics.
