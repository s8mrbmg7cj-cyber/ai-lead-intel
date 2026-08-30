# A2P 10DLC Registration — Google Review Requests

Everything a carrier, The Campaign Registry (TCR), or Twilio's vetting team asks
for when registering the **Review Requests** campaign. Copy the blocks below
straight into the Twilio Console.

Placeholders are wrapped in `<< >>`. **Fill every one before submitting** —
a mismatch between what's registered here and what the code actually sends is
the number-one cause of campaign rejection.

---

## 1. Brand

| Field | Value |
| --- | --- |
| Legal company name | Apex Growth Investments LLC |
| DBA / brand name | AI Lead Intel |
| Entity type | Private Company (LLC) |
| Country of registration | United States |
| EIN / Tax ID | `<<EIN — 9 digits, no dash>>` |
| Registered street address | `<<street>>` |
| City / State / ZIP | `<<city>>`, `<<ST>>` `<<ZIP>>` |
| Website | https://aileadintel.com |
| Vertical | Professional Services / Technology |
| Support email | hello@aileadintel.com |
| Support phone | `<<support phone in +1XXXXXXXXXX>>` |
| Brand contact name | `<<your legal first + last name>>` |
| Brand contact title | Owner |

> The EIN and legal name must match the IRS CP-575 / EIN letter **character for
> character**, including "LLC" with no period. TCR does an exact-match lookup;
> "Apex Growth Investments, LLC" with a comma will fail vetting.

---

## 2. Campaign

| Field | Value |
| --- | --- |
| Use case | **Low Volume Mixed** (or **Customer Care** if only this campaign runs on the number) |
| Campaign description | See §2.1 |
| Message flow / opt-in description | See §3 |
| Sample messages | See §4 |
| Help keywords | HELP, INFO |
| Help message | See §4.5 |
| Opt-out keywords | STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT, REVOKE, OPTOUT |
| Opt-out message | See §4.4 |
| Opt-in keywords | *(none — opt-in is collected offline, see §3)* |
| Embedded links | **Yes** |
| Embedded phone numbers | No |
| Age-gated content | No |
| Direct lending / loan arrangement | No |
| Affiliate marketing | No |
| Number pooling | `<<Yes if >50 numbers on the Messaging Service, otherwise No>>` |

### 2.1 Campaign description (paste verbatim)

```
AI Lead Intel provides AI phone answering software to home-service businesses
(HVAC, plumbing, electrical, roofing). After one of our business customers
completes a job for their own end customer, this campaign sends that end
customer a single follow-up text asking them to leave a Google review for the
business they just hired. One optional reminder may follow if the first message
is not acted on. Every message is sent from the business's own dedicated phone
number, identifies the business by name, and includes opt-out instructions.
Messages are only sent to individuals who have an existing business
relationship with the sender and who verbally or in writing agreed to receive a
text. No purchased lists, no cold outreach, no promotional or marketing content.
```

### 2.2 Why "embedded links" is Yes

Every message contains one shortened link on our own domain
(`https://aileadintel.com/r/<token>`) which 302-redirects to that business's
Google review page. The destination is stored server-side per request and is
never taken from a URL parameter, so it cannot be repointed. Public URL
shorteners (bit.ly, tinyurl) are **not** used — carriers block them.

---

## 3. Opt-in / consent flow (paste verbatim)

```
Consent is collected offline by the business at the point of service, not on a
web form, because these are existing customers of a home-service company.

The business's technician or office staff asks the customer, at the time the job
is completed: "Is it okay if we text you a link to leave us a Google review?"

Only if the customer agrees does the business open their AI Lead Intel dashboard
and submit that customer's name and mobile number. The submission form requires
the business to tick a mandatory attestation checkbox reading:

  "This customer gave me permission to text them about a Google review. I
   understand I may not text customers who have not agreed."

and to select how permission was given (in person, over the phone, on a signed
work order, by texting us first, or via a checkbox on the business's own website
form). The request is rejected by the API if the attestation is absent.

The identity of the staff member who attested, the timestamp, and the consent
method are written to the review_requests record and retained for the life of
the account. A customer who replies STOP is written to a permanent opt-out
ledger and can never be re-added, and any messages already queued for that
number are cancelled at the same moment.

The program's terms and privacy policy are published at
https://aileadintel.com/sms-opt-in , https://aileadintel.com/terms and
https://aileadintel.com/privacy .
```

**Consent disclosure shown to the end customer** (the business is instructed to
say or include this at the point of consent):

> `<<Business Name>>` will send you 1–2 text messages about leaving a Google
> review. Msg & data rates may apply. Reply STOP to opt out, HELP for help.

---

## 4. Sample messages

All five are produced by `lib/review-requests.js`. Every one identifies the
sender, states the purpose, and carries `Reply STOP to opt out, HELP for help.`
The builders trim the business name so the finished message is always **≤ 320
characters**.

### 4.1 First ask — with customer name

```
Hi Sarah, thanks for choosing Northside Heating & Air! If we did a good job,
would you mind leaving a quick Google review? https://aileadintel.com/r/k7m2xq9b4t
Reply STOP to opt out, HELP for help.
```

### 4.2 First ask — no name on file

```
Thanks for choosing Northside Heating & Air! If we did a good job, would you
mind leaving a quick Google review? https://aileadintel.com/r/p3n8rw5jzc
Reply STOP to opt out, HELP for help.
```

### 4.3 Follow-up (optional, once, never after a click)

```
Hi Sarah, just one quick nudge from Northside Heating & Air — a Google review
really helps us out. Last time we'll ask! https://aileadintel.com/r/k7m2xq9b4t
Reply STOP to opt out, HELP for help.
```

### 4.4 STOP confirmation (auto-reply)

```
You're unsubscribed from Northside Heating & Air review requests and won't
receive any more messages. Reply HELP for help.
```

### 4.5 HELP reply (auto-reply)

```
Northside Heating & Air review requests, powered by AI Lead Intel. For help
email hello@aileadintel.com. Msg&data rates may apply. Reply STOP to opt out.
```

---

## 5. Twilio Console configuration

Do these **after** the campaign is approved, on the Messaging Service that owns
the customer phone numbers.

1. **Messaging Service → Integration → "A message comes in"**
   Set to `https://aileadintel.com/api/twilio-webhook` (HTTP POST).
   This must be set on **every** number that sends review texts, or a STOP
   arrives with nowhere to go.

2. **Messaging Service → Integration → "Delivery status callback URL"**
   Set to the same `https://aileadintel.com/api/twilio-webhook`.

3. **Messaging Service → Opt-Out Management**
   - Leave **Advanced Opt-Out ON**. Twilio's carrier-level block is the
     authoritative stop; our ledger is what prevents us from *queueing*.
   - **Turn OFF the HELP auto-response.** Twilio's generic HELP text and our
     per-business one would otherwise both fire, and only ours names the
     business. Twilio's default STOP confirmation may stay on — when it does,
     it suppresses our TwiML confirmation, which is harmless because both say
     the same thing.

4. **Numbers must be attached to the Messaging Service**, not just to the
   account, or they inherit no campaign and get filtered.

---

## 6. Compliance guarantees enforced in code

Point a reviewer at these if asked to demonstrate compliance.

| Requirement | Where it's enforced |
| --- | --- |
| No message without stored consent | `api/review-request-create.js` — rejects `consent !== true` and a blank `consent_method` before any write |
| Consent record retained (who / when / how) | `review_requests.consent_captured_at`, `consent_method`, `consent_captured_by` |
| STOP honoured permanently | `sms_opt_outs` ledger, checked in `isOptedOut()` immediately before **every** send, including follow-ups |
| STOP cancels queued messages | `recordOptOut()` flips all `pending/sending/sent` rows for that number to `opted_out` in the same call |
| STOP/HELP always answered | `api/twilio-webhook.js` CASE 0 runs before any lookup that could early-return; the DB write is wrapped so a failure still produces the reply and escalates |
| Sender identified in every message | Business name is a required argument to every builder in `lib/review-requests.js` |
| Opt-out language in every message | `OPT_OUT_TAG` appended by all outbound builders — no code path bypasses them |
| Under 320 characters | `MAX_SMS_CHARS`; the business name is trimmed to fit |
| One follow-up maximum, ever | `follow_up_sent_at` is stamped as the claim itself, so a row can never re-qualify |
| Never double-send | Atomic conditional PATCH claim in `api/review-request-send.js`; state written before the send |
| No bulk / purchased lists | There is no import endpoint. One row per manual submission, rate-limited to 60/hour/IP |
| Link cannot be hijacked | `api/review-click.js` reads the destination from the stored row only and re-validates `https:` before the 302 |

---

## 7. Volume estimate for the campaign form

| Field | Value |
| --- | --- |
| Expected messages per day | `<<start conservative: 50>>` |
| Expected recipients per day | `<<same as above>>` |

Under-declaring is safer than over-declaring — the throughput can be raised
later, but a big number on a new brand triggers manual vetting.

---

## 8. Ongoing obligations

- **Never** delete rows from `sms_opt_outs`. There is no START/UNSTOP re-opt-in
  path, and adding one would require its own consent capture.
- If a business is caught sending to non-consenting customers, disable
  `review_requests_enabled` on their `clients` row immediately. Carrier
  complaints attach to *our* brand, not theirs.
- Re-verify the brand's EIN and address with TCR annually.
- Any change to message wording that removes the business name or the STOP
  language requires re-submitting sample messages to TCR.
