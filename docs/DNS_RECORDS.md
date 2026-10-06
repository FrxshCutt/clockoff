# DNS records for clockoff.online (Cloudflare)

This is the authoritative inventory and runbook for the `clockoff.online` DNS zone. Update it in the same
commit as any DNS change.

| Item                 | Value                                                                                                                                                                                                                                  |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Registrar            | IONOS (unchanged). The IONOS mailbox (e.g. `support@clockoff.online`) is unchanged.                                                                                                                                                    |
| Authoritative DNS    | Cloudflare zone `clockoff.online`, free plan, status `active`                                                                                                                                                                          |
| Nameservers          | `lola.ns.cloudflare.com`, `thaddeus.ns.cloudflare.com` (delegated by the `.online` registry, verified with `dig`)                                                                                                                      |
| Zone id              | `e2bcea4df92e1b74449156c648c2cd78` (an identifier, not a secret)                                                                                                                                                                       |
| Moved to Cloudflare  | 2026-10-06                                                                                                                                                                                                                             |
| How changes are made | Through the Cloudflare API only (see [Runbook](#5-runbook))                                                                                                                                                                            |
| API credential       | Cloudflare API token with Zone → DNS → Edit on `clockoff.online`. Kept only in the local, gitignored `.env.deploy` as `DNS_API_TOKEN`, with `DNS_ZONE_ID` and `DNS_PROVIDER=cloudflare`. Never set on Netlify; the app never reads it. |

Before the move the owner deleted the IONOS parking records at the apex: A `217.160.0.186` and AAAA
`2001:8d8:100f:f000::200`. Both were verified absent through the Cloudflare API, so no deletions were needed.
IONOS, as registrar, only holds the delegation to the Cloudflare nameservers; every record is served from the
Cloudflare zone. The IONOS DNS panel is no longer authoritative, so records edited there have no effect.

## 1. Zone rules (mandatory)

These are the owner's rules. They apply to every change.

1. **DNS only.** Every record is DNS only (`"proxied": false`, grey cloud). Never turn on Cloudflare proxying
   (orange cloud) for any record. Proxying breaks Netlify's Let's Encrypt certificate issuance and renewal, and
   it breaks mail lookups.
2. **Never modify or delete the MX records or the apex SPF TXT.** They carry the IONOS mailbox.
3. **One SPF TXT at the apex.** The apex holds exactly one `v=spf1` record:
   `v=spf1 include:_spf-eu.ionos.com ~all`. Never add a second one. Two SPF records at one name make SPF fail.
   A sending service gets SPF on its own subdomain, as Resend does with `send`.
4. **One `_dmarc` record.** `_dmarc` holds exactly one record (today a CNAME to IONOS). Never add a second.
   A name can hold only one DMARC policy, and a CNAME cannot coexist with any other record at the same name.
5. **Back up before any destructive call.** Before any edit or delete, export the full record set to
   `docs/dns-backup-<UTC timestamp>.json` (timestamp format `YYYYMMDDTHHMMSSZ`) and commit it. See
   [Back up](#53-back-up). Backups are excluded from Prettier (`.prettierignore`), so they stay byte-for-byte
   as exported.

Conventions: TTL Auto (`"ttl": 1`) on every record, and a Cloudflare `comment` on every record we create that
says what it is for.

## 2. Record inventory

13 records, all TTL Auto, none proxied. Verified through the Cloudflare API on 2026-10-06.

- **Netlify:** 3 records (website and app).
- **Resend:** 4 records (outgoing email).
- **IONOS mail and services:** 6 records. Preserve them as they are.

Names are relative to `clockoff.online` (`@` is the apex). The API uses the full name, e.g.
`www.clockoff.online`.

| Group   | Type  | Name                | Content                                                                                                                                                                                                                      | Priority | Proxied | Purpose / owner                                               | Do not touch                                                   |
| ------- | ----- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------- | ------------------------------------------------------------- | -------------------------------------------------------------- |
| Netlify | A     | `@`                 | `75.2.60.5`                                                                                                                                                                                                                  | —        | `false` | Netlify load balancer → marketing site                        | No (ours; back up before changing)                             |
| Netlify | CNAME | `www`               | `clockoff.netlify.app`                                                                                                                                                                                                       | —        | `false` | Netlify; Netlify 301-redirects `www` → apex                   | No (ours; back up before changing)                             |
| Netlify | CNAME | `app`               | `clockoff.netlify.app`                                                                                                                                                                                                       | —        | `false` | Netlify; manager dashboard and every `/api/*` route (iOS app) | No (ours; back up before changing)                             |
| Resend  | TXT   | `resend._domainkey` | `p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC0qMV9iSfAi9160s632a9ZXHyQClSQDn08fhNzDICGDTBYNGoXc7a4q0ZiVUgnWgpKd/5hPWbt/uPtpG5tK7Pak+fSBBgFtU73HPiX/5uBRuodcOmBKO8NjOlbW5bxGIKAwIshTPdG17mGzW/SSsZE0lOAnZZM4F3Ih2cnIVL45wIDAQAB` | —        | `false` | Resend DKIM public key                                        | No (ours; back up before changing)                             |
| Resend  | MX    | `send`              | `feedback-smtp.eu-west-1.amazonses.com`                                                                                                                                                                                      | 10       | `false` | Resend bounce/feedback (envelope sender domain)               | No (ours; back up before changing)                             |
| Resend  | TXT   | `send`              | `v=spf1 include:amazonses.com ~all`                                                                                                                                                                                          | —        | `false` | Resend SPF on the sending subdomain                           | No (ours; back up before changing)                             |
| Resend  | CNAME | `rsend`             | `send.forge.rmta.net`                                                                                                                                                                                                        | —        | `false` | Resend return-path/tracking record                            | No (ours; back up before changing)                             |
| IONOS   | MX    | `@`                 | `mx00.ionos.co.uk`                                                                                                                                                                                                           | 10       | `false` | IONOS mailbox                                                 | **Yes.** Never modify or delete.                               |
| IONOS   | MX    | `@`                 | `mx01.ionos.co.uk`                                                                                                                                                                                                           | 10       | `false` | IONOS mailbox                                                 | **Yes.** Never modify or delete.                               |
| IONOS   | TXT   | `@`                 | `v=spf1 include:_spf-eu.ionos.com ~all`                                                                                                                                                                                      | —        | `false` | SPF for IONOS mail; the only SPF record at the apex           | **Yes.** Never modify or delete.                               |
| IONOS   | CNAME | `_dmarc`            | `dmarc.ionos.co.uk` (resolves to `v=DMARC1; p=none;`)                                                                                                                                                                        | —        | `false` | DMARC policy (IONOS)                                          | **Yes.** Keep. Only change: the owner's optional switch in §3. |
| IONOS   | CNAME | `autodiscover`      | `adsredir.ionos.info`                                                                                                                                                                                                        | —        | `false` | IONOS mail client autoconfig                                  | **Yes.** Keep.                                                 |
| IONOS   | CNAME | `_domainconnect`    | `_domainconnect.ionos.com`                                                                                                                                                                                                   | —        | `false` | IONOS Domain Connect                                          | **Yes.** Keep.                                                 |

The 7 Netlify and Resend records were created through the API at 20:55 UTC on 2026-10-06. Each carries a
Cloudflare `comment` describing it. The 6 IONOS records came over with the zone. After the change they were
re-read and are byte-identical to the pre-change backup (same ids, content, priority and proxied flag).

The API returns TXT content wrapped in double quotes (see the backup file). That is normal.

## 3. Email authentication (Resend)

| Item             | Value                                                                     |
| ---------------- | ------------------------------------------------------------------------- |
| Resend domain    | `clockoff.online`                                                         |
| Resend domain id | `538d0ad9-2bee-472e-9b12-36eff396662d`                                    |
| Region           | `eu-west-1`                                                               |
| Capability       | Sending only                                                              |
| From address     | `Work Mode <noreply@clockoff.online>`                                     |
| Netlify env      | `EMAIL_PROVIDER=resend`, `EMAIL_FROM` and `RESEND_API_KEY` set on Netlify |

### SPF: subdomain path

Resend's required records (read from `GET /domains/{id}` on the Resend API) put SPF on
`send.clockoff.online`: an MX to `feedback-smtp.eu-west-1.amazonses.com` and a TXT
`v=spf1 include:amazonses.com ~all`. They add the `rsend` CNAME and the DKIM record. `send.clockoff.online` is
the envelope sender (bounce) domain for Resend mail, so receivers check Resend's SPF there.

Resend does not require SPF at the apex. So the apex SPF (`v=spf1 include:_spf-eu.ionos.com ~all`) was left
untouched. There was no merge. This keeps the IONOS mailbox's SPF exactly as it was and keeps one SPF record
at the apex.

### DKIM

`resend._domainkey.clockoff.online` is a TXT record holding Resend's DKIM public key. The full value is in the
inventory (§2). Resend signs outgoing mail with the matching private key, which Resend holds.

### DMARC

- **No conflict.** Resend's required-record list contains no DMARC record.
- `_dmarc` stays a CNAME to `dmarc.ionos.co.uk`, which resolves to `v=DMARC1; p=none;`. Resend recommends
  having a DMARC policy, and `p=none` satisfies it.
- **Optional, owner decision.** For DMARC aggregate reports, replace the single `_dmarc` CNAME with ONE TXT
  record, e.g. `v=DMARC1; p=none; rua=mailto:support@clockoff.online`. Back up, delete the CNAME, then create
  the TXT. This is not required for sending.
- **Never add a second `_dmarc` record.** It would break DMARC for both IONOS and Resend mail.

### Resend verification status

**Verified.** Verification was requested at about 20:57 UTC on 2026-10-06. When checked at 22:39 UTC, Resend reported the domain and all four records (DKIM, `send` MX, `send` TXT, `rsend` CNAME) as `verified`. At 21:17 UTC it had still been `pending` although every record already resolved from 1.1.1.1, 1.0.0.1, 8.8.8.8, 9.9.9.9 and 208.67.222.222: Resend re-checks periodically, and the zone’s 1800 s negative-cache TTL can delay a resolver that looked a name up before it existed.

A test email from `noreply@clockoff.online` to `support@clockoff.online` was sent at 22:40 UTC and Resend reported it `delivered` 5 seconds later.

## 4. Netlify and TLS

| Item           | Value                                                                          |
| -------------- | ------------------------------------------------------------------------------ |
| Netlify site   | `clockoff` (`clockoff.netlify.app`, id `b65c1658-1110-42ec-a926-637ae7d9415f`) |
| Custom domain  | `clockoff.online` (primary)                                                    |
| Domain aliases | `www.clockoff.online`, `app.clockoff.online`                                   |
| Netlify DNS    | None. DNS is external (Cloudflare); there is no Netlify DNS zone.              |

### How each hostname behaves

Verified with `curl -I` at 21:05 UTC on 2026-10-06.

| Request                             | Response                                                                                                                                                                  | Done by                         |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `https://clockoff.online/`          | 200, marketing page                                                                                                                                                       | Netlify (web app)               |
| `https://www.clockoff.online/`      | 301 → `https://clockoff.online/`                                                                                                                                          | Netlify primary-domain redirect |
| `https://app.clockoff.online/`      | 307 → `/overview`; `/login` renders "Sign in to Work Mode"                                                                                                                | App middleware                  |
| `http://` on any of the three hosts | 301 → `https://`                                                                                                                                                          | Netlify                         |
| Apex `/login`, `/overview`          | 308 → `app.clockoff.online`                                                                                                                                               | App cross-host routing          |
| App `/pricing`                      | 308 → apex                                                                                                                                                                | App cross-host routing          |
| Apex `/api/mobile/v1/me`            | 404. Apart from `/api/health` and `/api/request-demo`, every `/api/*` route is served on `app` only; iOS Release builds call `https://app.clockoff.online/api/mobile/v1`. | App (`hostRouting.ts`)          |
| `/api/health` on app and apex       | 200 `{"status":"ok","database":"ok","migrations":"up_to_date","time":"…"}`                                                                                                | App                             |

### Certificate

- One Let's Encrypt certificate: CN `clockoff.online`, SANs `clockoff.online`, `www.clockoff.online` and
  `app.clockoff.online`.
- Requested through the Netlify API (`POST /sites/{id}/ssl`) at ~20:57 UTC on 2026-10-06. State `issued`
  about 5 minutes later.
- Valid until **2027-01-04**.
- Netlify renews it automatically while all three records keep pointing at Netlify (apex A `75.2.60.5`,
  `www` and `app` CNAME `clockoff.netlify.app`) and stay DNS only. If a record is repointed or proxied,
  renewal fails and browsers reject the site once the certificate expires.
- Apex and app responses send `Strict-Transport-Security: max-age=63072000; includeSubDomains` (set in
  `apps/web/src/server/http/securityHeaders.ts`). Because of `includeSubDomains`, any new web-facing
  subdomain must serve valid HTTPS.

## 5. Runbook

All commands run from the repo root and need `curl`, `jq` and `dig`.

### 5.1 Set up the shell

Copy the two values from the local, gitignored `.env.deploy` into your shell. Never paste the token into a
doc, a commit, a script in the repo or Netlify.

```bash
export CF_API_TOKEN='<value of DNS_API_TOKEN>'
export CF_ZONE_ID='<value of DNS_ZONE_ID>'
```

### 5.2 List

```bash
curl -s -H "Authorization: Bearer $CF_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/zones/$CF_ZONE_ID/dns_records?per_page=100" \
  | jq -r '.result[] | [.id, .type, .name, (.priority // "-"), .proxied, .content] | @tsv'
```

Expected: 13 lines matching the inventory (§2), with `false` in the proxied column on every line.

Find one record's id:

```bash
curl -s -H "Authorization: Bearer $CF_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/zones/$CF_ZONE_ID/dns_records?type=CNAME&name=www.clockoff.online" \
  | jq -r '.result[] | "\(.id) \(.type) \(.name) \(.content)"'
```

### 5.3 Back up

Run this before any edit or delete, then commit the file before making the change.

```bash
ts=$(date -u +%Y%m%dT%H%M%SZ)
out="docs/dns-backup-$ts.json"
curl -s -H "Authorization: Bearer $CF_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/zones/$CF_ZONE_ID/dns_records?per_page=100" \
  | jq --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg zone "$CF_ZONE_ID" '
      if .success then {
        exported_at: $at,
        source: "Cloudflare API GET /zones/{zone_id}/dns_records",
        zone: { id: $zone, name: "clockoff.online" },
        record_count: (.result | length),
        records: .result
      } else error("Cloudflare API call failed") end' > "$out"
jq '.record_count' "$out"   # must print the current count (13 today)
git add "$out" && git commit -m "chore(dns): back up zone before <change>"
```

If the count is missing or wrong, delete that file and stop. Do not run Prettier on backup files. Add the new
file to the [backup list](#59-backups).

### 5.4 Create

Creating does not change existing records, so no backup is needed. Check first that the name is free: a
CNAME cannot share a name with any other record, and the apex SPF and `_dmarc` rules (§1) still apply. Always
send `"proxied": false` and a `comment`. For an MX record add `"priority": 10` (or the value required).

```bash
curl -s -X POST \
  -H "Authorization: Bearer $CF_API_TOKEN" -H "Content-Type: application/json" \
  "https://api.cloudflare.com/client/v4/zones/$CF_ZONE_ID/dns_records" \
  --data '{"type":"CNAME","name":"<name>.clockoff.online","content":"<target>","ttl":1,"proxied":false,"comment":"<what it is for and who owns it>"}' \
  | jq '{success, errors, id: .result.id}'
```

Add the record to the inventory (§2) in the same commit.

### 5.5 Edit

Back up first (§5.3). Never edit the MX records or the apex SPF. `PATCH` changes only the fields you send.

```bash
RECORD_ID='<id from the list>'
curl -s -X PATCH \
  -H "Authorization: Bearer $CF_API_TOKEN" -H "Content-Type: application/json" \
  "https://api.cloudflare.com/client/v4/zones/$CF_ZONE_ID/dns_records/$RECORD_ID" \
  --data '{"content":"<new value>","proxied":false}' \
  | jq '{success, errors}'
```

### 5.6 Delete

Back up first (§5.3). Never delete the MX records or the apex SPF. List the record first and check the id.

```bash
RECORD_ID='<id from the list>'
curl -s -X DELETE \
  -H "Authorization: Bearer $CF_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/zones/$CF_ZONE_ID/dns_records/$RECORD_ID" \
  | jq '{success, errors}'
```

### 5.7 Restore from a backup

Back up the current state first (§5.3), so the restore itself can be undone. Then re-create each record in the
backup's `records[]` with its type, name, content, ttl, priority and proxied flag. The script below finds the
backup records that the zone no longer has and shows them for review.

```bash
BACKUP=docs/dns-backup-<timestamp>.json
now=$(curl -s -H "Authorization: Bearer $CF_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/zones/$CF_ZONE_ID/dns_records?per_page=100")
missing=$(jq -c --argjson now "$now" '
  [$now.result[] | [.type, .name, .content, .priority]] as $have
  | .records[]
  | select([.type, .name, .content, .priority] as $k | any($have[]; . == $k) | not)
  | {type, name, content, ttl, proxied}
    + (if .priority != null then {priority} else {} end)
    + (if .comment != null then {comment} else {} end)' "$BACKUP")
echo "$missing"   # review before re-creating
```

If a listed record still exists with a different value, `PATCH` it back (§5.5) or delete the wrong one (§5.6)
first. Never touch the MX records or the apex SPF this way.
Otherwise re-create the missing records:

```bash
echo "$missing" | while read -r rec; do
  [ -n "$rec" ] || continue
  curl -s -X POST \
    -H "Authorization: Bearer $CF_API_TOKEN" -H "Content-Type: application/json" \
    "https://api.cloudflare.com/client/v4/zones/$CF_ZONE_ID/dns_records" --data "$rec" \
    | jq -c '{success, errors, type: .result.type, name: .result.name}'
done
```

The pre-change backup holds only the 6 IONOS records. To rebuild the Netlify and Resend records, create them
from the inventory (§2).

### 5.8 Verify

```bash
dig +short clockoff.online NS                     # lola.ns.cloudflare.com. and thaddeus.ns.cloudflare.com.
dig +short clockoff.online A                      # 75.2.60.5 (only)
dig +short clockoff.online AAAA                   # (nothing)
dig +short www.clockoff.online                    # clockoff.netlify.app. then Netlify IPs
dig +short app.clockoff.online                    # clockoff.netlify.app. then Netlify IPs
dig +short send.clockoff.online MX                # 10 feedback-smtp.eu-west-1.amazonses.com.
dig +short send.clockoff.online TXT               # "v=spf1 include:amazonses.com ~all"
dig +short rsend.clockoff.online CNAME            # send.forge.rmta.net.
dig +short resend._domainkey.clockoff.online TXT  # "p=MIGfMA0G...wIDAQAB" (the full DKIM value in §2)
dig +short clockoff.online MX                     # 10 mx00.ionos.co.uk. and 10 mx01.ionos.co.uk.
dig +short clockoff.online TXT                    # "v=spf1 include:_spf-eu.ionos.com ~all" (the only v=spf1)
dig +short _dmarc.clockoff.online TXT             # dmarc.ionos.co.uk. then "v=DMARC1; p=none;"
```

Add `@1.1.1.1` or `@8.8.8.8` to test a specific public resolver. Add `@lola.ns.cloudflare.com` to see the
zone's own answer without any cache.

HTTPS checks (expected answers from §4):

```bash
curl -sI https://clockoff.online/ | head -1                                      # 200
curl -sI https://www.clockoff.online/ | grep -i -e '^HTTP' -e '^location'        # 301 to https://clockoff.online/
curl -sI https://app.clockoff.online/ | grep -i -e '^HTTP' -e '^location'        # 307 to /overview
curl -sI http://clockoff.online/ | grep -i -e '^HTTP' -e '^location'             # 301 to https://
curl -s https://app.clockoff.online/api/health                                  # {"status":"ok","database":"ok","migrations":"up_to_date","time":"…"}
```

### 5.9 Backups

| File                                    | Exported (UTC)      | Records | Contents                                                                                                                                                                                                              |
| --------------------------------------- | ------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/dns-backup-20261006T205519Z.json` | 2026-10-06 20:55:20 | 6       | Pre-change state: the 6 IONOS records (2 MX, apex SPF, `_dmarc`, `autodiscover`, `_domainconnect`), taken before the Netlify and Resend records were created. Verbatim Cloudflare API export, committed in `e8bdfe2`. |
