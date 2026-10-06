# DNS records for clockoff.online (IONOS)

DNS for `clockoff.online` stays at IONOS (nameservers `ns10xx.ui-dns.*`). These records connect the domain to
Netlify (website + app) and to Resend (outgoing email). They are added by hand in the IONOS control panel:
**Domains & SSL → clockoff.online → DNS**.

Values were read back from Netlify (site `clockoff`, `clockoff.netlify.app`) and from the Resend API (domain id
`538d0ad9-2bee-472e-9b12-36eff396662d`, region `eu-west-1`) on 2026-10-06.

## Before you start

- **Turn off any IONOS "Website" or "Redirect"/"Forwarding" setting on the domain** (Domains & SSL →
  clockoff.online → the gear/"Use domain" menu → set it to "DNS only"/remove the website or redirect).
  IONOS's website and redirect features override the A/AAAA records below.
- In the IONOS record form, the **Hostname** for the root domain is `@`. If the form has no `@` option, leave the
  hostname **empty** — that means the same thing.
- Leave TTL at the IONOS default.
- Paste TXT values **without** surrounding quotes.

## 1. Delete these two records

| Type | Hostname | Current value             | Why                                                                                                                                                   |
| ---- | -------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| A    | `@`      | `217.160.0.186`           | IONOS parking page. Replaced by Netlify below.                                                                                                        |
| AAAA | `@`      | `2001:8d8:100f:f000::200` | IONOS parking page over IPv6. **If you leave it, IPv6 visitors (most mobile networks) still land on the parking page.** Netlify needs no AAAA record. |

## 2. Add — website and app (Netlify)

| Type  | Hostname | Value                  | Priority |
| ----- | -------- | ---------------------- | -------- |
| A     | `@`      | `75.2.60.5`            | —        |
| CNAME | `www`    | `clockoff.netlify.app` | —        |
| CNAME | `app`    | `clockoff.netlify.app` | —        |

`clockoff.online` and `www.clockoff.online` serve the marketing site (`www` redirects to the apex);
`app.clockoff.online` serves the manager dashboard and every `/api/*` route (the iOS app talks to it). Netlify
issues HTTPS certificates for all three automatically once they resolve.

## 3. Add — outgoing email (Resend)

| Type  | Hostname            | Value                                                                                                                                                                                                                        | Priority |
| ----- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| TXT   | `resend._domainkey` | `p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC0qMV9iSfAi9160s632a9ZXHyQClSQDn08fhNzDICGDTBYNGoXc7a4q0ZiVUgnWgpKd/5hPWbt/uPtpG5tK7Pak+fSBBgFtU73HPiX/5uBRuodcOmBKO8NjOlbW5bxGIKAwIshTPdG17mGzW/SSsZE0lOAnZZM4F3Ih2cnIVL45wIDAQAB` | —        |
| MX    | `send`              | `feedback-smtp.eu-west-1.amazonses.com`                                                                                                                                                                                      | `10`     |
| TXT   | `send`              | `v=spf1 include:amazonses.com ~all`                                                                                                                                                                                          | —        |
| CNAME | `rsend`             | `send.forge.rmta.net`                                                                                                                                                                                                        | —        |

These live on the `send`, `rsend` and `resend._domainkey` sub-names, so they do **not** interfere with your
IONOS mailbox records on the root domain. They let Work Mode send verification, password-reset and invite
emails from `noreply@clockoff.online`.

## 4. Do not touch

| Type                                         | Hostname | Value                                                 | What it is                                           |
| -------------------------------------------- | -------- | ----------------------------------------------------- | ---------------------------------------------------- |
| MX                                           | `@`      | `mx00.ionos.co.uk` / `mx01.ionos.co.uk` (priority 10) | Your IONOS mailbox (e.g. `support@clockoff.online`). |
| TXT                                          | `@`      | `v=spf1 include:_spf-eu.ionos.com ~all`               | SPF for mail sent through IONOS.                     |
| CNAME                                        | `_dmarc` | `dmarc.ionos.co.uk` (→ `v=DMARC1; p=none;`)           | DMARC policy.                                        |
| any other TXT/SPF/DMARC/autodiscover records |          |                                                       | Mail and verification records.                       |

### About DMARC

Resend recommends a DMARC record of `v=DMARC1; p=none;` — the existing IONOS `_dmarc` record already publishes
exactly that, so **keep the IONOS one and do not add another**. A name can hold only one DMARC policy (and a
CNAME cannot coexist with a TXT record), so adding a second `_dmarc` record would break DMARC for both IONOS and
Resend mail. If you later want DMARC reports, replace the IONOS CNAME with a single TXT record such as
`v=DMARC1; p=none; rua=mailto:support@clockoff.online`.

## After adding the records

Tell Claude (or check yourself):

```bash
dig +short clockoff.online A          # → 75.2.60.5 only
dig +short clockoff.online AAAA       # → (nothing)
dig +short www.clockoff.online        # → clockoff.netlify.app. + Netlify IPs
dig +short app.clockoff.online        # → clockoff.netlify.app. + Netlify IPs
dig +short send.clockoff.online MX    # → 10 feedback-smtp.eu-west-1.amazonses.com.
dig +short resend._domainkey.clockoff.online TXT
```

Propagation through IONOS usually takes a few minutes, occasionally up to an hour.
