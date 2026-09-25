# Go-live runbook — AWS

How the bot goes from a laptop behind ngrok to a server that real leads reach.
One box on AWS, Docker Compose, Postgres backed up to S3 nightly. Written to be
followed top to bottom once, and then consulted for operations.

**The shape:** `caddy` (TLS) → `app` → `postgres` + `redis`, plus a `backup`
container. Defined in [`docker-compose.prod.yml`](../docker-compose.prod.yml);
deployed by [`deploy/deploy.sh`](../deploy/deploy.sh).

---

## 0. Before touching AWS

| | Done? |
|---|---|
| **E-1 Meta Business verification** submitted. Nothing below matters until the app leaves Development mode: real form leads are not delivered and templates only reach allow-listed numbers. | |
| Lidor's **business WhatsApp number** added to the WABA (`1575810494087631`) and verified. The templates and quality rating attach to the number; the test number (+1 555…) never goes live. | |
| A **domain** for the webhook, e.g. `bot.lidorbarel.co.il`, that you control DNS for. | |
| An **AWS account** with billing set up. | |
| The six **testimonial/promo videos** (`assets/recommendations/*.mp4`, not in git) at hand. | |

## 1. The server

1. **Region.** `il-central-1` (Tel Aviv) keeps the data in Israel. Create the
   instance there if the service offers it; Lightsail's region list changes, so
   check — if Lightsail is not offered in Tel Aviv, use an **EC2 `t4g.small`**
   there (same steps from step 3 on), or Lightsail in `eu-central-1`.
2. **Instance.** Lightsail: Linux, **Ubuntu 24.04**, the **2 GB / 2 vCPU** plan
   (~$12/mo). Attach a **static IP**. Firewall: allow **22, 80, 443** only.
   EC2: `t4g.small`, Ubuntu 24.04 (arm64), 20 GB gp3, an Elastic IP, a security
   group with the same three ports.
3. **DNS.** An `A` record for the domain → the static IP. Caddy needs this to
   resolve before it can get a certificate.
4. **Docker.**

   ```bash
   sudo apt-get update && sudo apt-get install -y ca-certificates curl git
   curl -fsSL https://get.docker.com | sudo sh
   sudo usermod -aG docker $USER && newgrp docker
   docker compose version
   ```

5. **Code.**

   ```bash
   git clone git@github.com:roieGolst/LidorBarel-WhatsappBot.git ~/bot && cd ~/bot
   ```

   (Add the server's SSH key as a **read-only deploy key** on the repository.)

## 2. Backups bucket (do this before the first start)

Postgres is the single source of truth; the `backup` container is what makes a
dead disk survivable. It needs somewhere to put dumps.

1. **S3 bucket** in the same region, e.g. `lidor-bot-backups`, block all public
   access, versioning off.
2. **Lifecycle rule** on the bucket: expire objects after **90 days**. Retention
   lives here, not in the script.
3. **IAM user** `lidor-bot-backup` with programmatic access and exactly this
   inline policy (replace the bucket name):

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       { "Effect": "Allow", "Action": ["s3:ListBucket"], "Resource": "arn:aws:s3:::lidor-bot-backups" },
       {
         "Effect": "Allow",
         "Action": ["s3:PutObject", "s3:GetObject"],
         "Resource": "arn:aws:s3:::lidor-bot-backups/lidor-bot/*"
       }
     ]
   }
   ```

   Its access key goes into `.env` as `BACKUP_AWS_ACCESS_KEY_ID` /
   `BACKUP_AWS_SECRET_ACCESS_KEY`. It can do nothing else.

## 3. Configuration

```bash
cp deploy/env.production.example .env && chmod 600 .env && nano .env
```

Fill every blank. Notes that bite:

- `DOMAIN` — the hostname from step 1.3.
- `POSTGRES_PASSWORD` — `openssl rand -hex 24`; put the same value inside
  `DATABASE_URL`.
- `META_ACCESS_TOKEN` — a **System User** token (permanent). The temporary token
  from the dashboard expires in 24 hours and takes the bot down with it.
- `META_PHONE_NUMBER_ID` — Lidor's number's id, not the test number's.
- `META_WEBHOOK_VERIFY_TOKEN` — `openssl rand -hex 32`; you enter it in Meta in step 5.
- `OUTREACH_ENABLED=false` for now. Step 6 flips it.

Then the videos:

```bash
# from your machine
scp assets/recommendations/*.mp4 <server>:~/bot/assets/recommendations/
```

## 4. First deploy

```bash
./deploy/deploy.sh
```

This builds the image, starts Postgres and Redis, applies migrations in a
one-off container, then starts the app, Caddy and the backup job. Verify:

```bash
docker compose -f docker-compose.prod.yml ps          # every service "running (healthy)"
docker compose -f docker-compose.prod.yml logs app | tail -20
curl https://$DOMAIN/health                            # {"status":"ok"} over real TLS
```

The `server started` log line lists which subsystems are enabled
(`whatsappConfigured`, `leadgenIntake`, `mondayProjection`,
`proactiveOutreach`). All but the last should be `enabled`/`true`.

### Prove the backup restores — once, now

A backup nobody has restored is a hope, not a backup.

```bash
C="docker compose -f docker-compose.prod.yml"
$C exec backup backup.sh                                   # take one now
$C exec backup sh -c 'ls -la /backups'                     # a .dump exists
aws s3 ls s3://lidor-bot-backups/lidor-bot/                 # …and is in S3
$C exec backup restore.sh /backups/<file>.dump lidor_bot_restore_test
```

The last command restores into a scratch database and prints row counts. It
must succeed. Repeat it after any change to the backup setup, and every few
months.

## 5. Point Meta at the server

In the Meta App dashboard (app `1736023980972865`), replace the ngrok URL in
**both** places — the WhatsApp product and the Page `leadgen` subscription share
one endpoint:

- Callback URL: `https://<DOMAIN>/webhooks/whatsapp`
- Verify token: the `META_WEBHOOK_VERIFY_TOKEN` from `.env`

Meta performs the handshake on save; it fails if the app is not up. Then confirm
the fields are still subscribed: `messages` (WhatsApp) and `leadgen` (Page
`110085325138352`). Re-subscribe the Page if in doubt:

```bash
curl -X POST "https://graph.facebook.com/v21.0/110085325138352/subscribed_apps" \
  -d "subscribed_fields=leadgen" -H "Authorization: Bearer $META_PAGE_ACCESS_TOKEN"
```

**Test inbound:** message Lidor's number from a phone. Expect the welcome
sequence, and the `לידים` board to gain the item within a minute.

**Test intake:** submit the seller form (`1746567036243410`) through Meta's Lead
Ads Testing Tool. Expect a contact and conversation in Postgres
(`docker compose -f docker-compose.prod.yml exec postgres psql -U lidor lidor_bot -c 'select count(*) from contacts'`)
and a board item. Delivery stays `Pending` while the app is in Development
mode — that is E-1, not the server.

### 5a. The public pages Meta requires

The app cannot go Live without a **Privacy Policy URL** and **Data Deletion
Instructions URL** (App Dashboard → Settings → Basic). Both are served by the bot
itself, so they are up whenever the webhook is:

| Setting | URL |
|---|---|
| Privacy Policy URL | `https://<DOMAIN>/privacy` |
| Data Deletion Instructions URL | `https://<DOMAIN>/data-deletion` (→ the deletion section of the same page) |

The page is `public/privacy.html`, rendered with the values the code enforces
(`src/site/privacyPage.ts`): the follow-up caps, `DATA_RETENTION_MONTHS`, and
`PRIVACY_CONTACT_EMAIL` when set (without it the page offers WhatsApp only). The
business details on it come from the עוסק מורשה certificate. Every promise on it
is implemented and tested — NN-8 (deletion on request), NN-9 (retention), NN-10
(a person on request), NN-1/NN-6 (opt-out words, log redaction) — so **changing a
rule means changing the code, not the page**. Two statements are operational and
yours to keep true: backups live in Israel (`BACKUP_AWS_REGION=il-central-1`) with
the 90-day lifecycle rule from step 2, and a calendar event of a person who asked
for deletion is removed by hand within 30 days (the scrubbed פעילות item says so).
Have a lawyer read the page once: it was drafted from what the system does, not
by a lawyer.

## 6. Switch outreach on

Only when all of these are true:

- [ ] E-1 approved; the app is in Live mode.
- [ ] Lidor's number is the one in `META_PHONE_NUMBER_ID`.
- [ ] `welcome_message`, `seller_followup_1`, `seller_followup_incomplete` show
      `APPROVED` for `he` on the WABA.
- [ ] `META_LEAD_CONSENT_FORMS` lists only the live form with its required
      consent checkbox (E-2), and `META_LEAD_CONSENT_TEXT` is its wording.
- [ ] The restore test in step 4 passed.

Then `OUTREACH_ENABLED=true` in `.env` and:

```bash
docker compose -f docker-compose.prod.yml up -d app
```

Watch the first real lead end to end: form → `awaiting_first_contact` → template
sent after the 20-minute grace → reply → conversation → board.

## 7. Operating it

| Task | Command (from `~/bot`) |
|---|---|
| Deploy a new version | merge to `main` — CI deploys it (§9). By hand: `git pull && ./deploy/deploy.sh` |
| Logs | `docker compose -f docker-compose.prod.yml logs -f app` |
| Status | `docker compose -f docker-compose.prod.yml ps` |
| Restart the app | `docker compose -f docker-compose.prod.yml restart app` |
| Change `.env` | edit, then `up -d app` (env is read at start) |
| Backup now | `… exec backup backup.sh` |
| Restore (to scratch) | `… exec backup restore.sh <dump> lidor_bot_restore_test` |
| Restore (over live) | stop the app first: `… stop app`, then `… exec backup restore.sh <dump>`, then `… start app` |
| Parked outbox rows | `… exec postgres psql -U lidor lidor_bot -c "select id, aggregate_id, attempts, last_error from outbox where status='failed'"` |
| Leads parked in `error` | `… -c "select id, error_state from conversations where stage='error'"` |

**What is not done for you:** nobody is alerted when the app is down. The
cheapest fix is an external uptime check on `https://<DOMAIN>/health` every 5
minutes (UptimeRobot's free tier, or a CloudWatch Synthetics canary) that
messages you. Do this in the first week.

**Rotating a token** (Meta or Monday): edit `.env`, `up -d app`. Nothing else
holds a copy.

**Disk:** the 20 GB fills with Docker images over months. `deploy.sh` prunes
dangling images on every run; if `df -h` ever shows `/` above 80 %, run
`docker system prune -f`.

## 8. Rollback

Every deploy is a git commit. To go back:

```bash
git checkout <previous-sha> && ./deploy/deploy.sh
```

With continuous deployment on (§9) the checkout above leaves the server on a
detached HEAD, and `deploy/remote-deploy.sh` **refuses to deploy onto one** — so
the next merge cannot silently undo your rollback. Once `main` is fixed,
`git checkout main` on the server resumes CD. To be doubly sure, set the
`DEPLOY_ENABLED` repository variable to `false` while you investigate.

Migrations are forward-only; a version whose migration has already run can be
rolled back in code but keeps the newer schema, which every version so far
tolerates (new columns are nullable). Check `drizzle/` before relying on that
for a future migration that drops or renames.

## 9. Continuous deployment

`.github/workflows/ci.yml` runs `npm run check` (against real Postgres and Redis
service containers) and `npm run build` on every pull request. On a push to
`main` it then deploys the commit that just passed: it SSHes to the server, which
fast-forwards to that commit and runs `deploy/deploy.sh` — the same single path as
a manual deploy — and finally checks `https://<DOMAIN>/health` from outside.

**Documentation-only changes skip all of it.** A first job diffs the change; if
every file is `*.md`, under `docs/`, or `LICENSE`, the gate, the build and the
deploy are skipped — none of those files can affect the suite (Prettier ignores
`*.md`) or the image. Anything else, including a file type nobody anticipated,
runs the full gate. The skipped `check` job still reports as passed, so it can be
a required status check without blocking a README fix.

**A merge does not re-run the suite.** The pull-request run tests the merge of
the PR into `main` and leaves a marker artifact named after the tree it tested.
When the merge lands, the push run finds the marker for its own tree and skips
straight to the deploy. If `main` moved in between, the trees differ, there is no
marker, and the gate runs as usual — so a merge is only ever deployed on a run
that tested exactly its code.

**The deploy key cannot open a shell.** It is pinned in `authorized_keys` to
`deploy/remote-deploy.sh`, which accepts one input — a commit sha — and refuses
anything that is not already on `origin/main`. A leaked GitHub secret can deploy
`main`; it cannot read `.env` or reach the database. The script also never moves
the server backwards, takes a lock so two deploys cannot overlap, and refuses to
run while the server is pinned to a rollback (§8).

### One-time setup

On the **server**:

```bash
# A key pair used for nothing else. No passphrase: a runner cannot type one.
ssh-keygen -t ed25519 -N '' -C github-actions-deploy -f ~/.ssh/github_deploy

# Pin it to the deploy script. `restrict` turns off forwarding and the pty.
echo "restrict,command=\"$HOME/bot/deploy/remote-deploy.sh\" $(cat ~/.ssh/github_deploy.pub)" >> ~/.ssh/authorized_keys

# The two values GitHub needs:
cat ~/.ssh/github_deploy                                          # → DEPLOY_SSH_KEY
echo "<DOMAIN> $(cut -d' ' -f1,2 /etc/ssh/ssh_host_ed25519_key.pub)"   # → DEPLOY_KNOWN_HOSTS
```

Then delete the private half from the server — only GitHub needs it:
`rm ~/.ssh/github_deploy`.

The server pulls from GitHub during a deploy, so its own read access to the
repository (the deploy key used for the original `git clone`) must stay in place.

In **GitHub → Settings → Secrets and variables → Actions**:

| Kind | Name | Value |
|---|---|---|
| Secret | `DEPLOY_HOST` | the bot's domain, e.g. `bot.lidorbarel.co.il` (also used for the `/health` check) |
| Secret | `DEPLOY_USER` | `ubuntu` |
| Secret | `DEPLOY_SSH_KEY` | the private key printed above, whole, including the `BEGIN`/`END` lines |
| Secret | `DEPLOY_KNOWN_HOSTS` | the `<DOMAIN> ssh-ed25519 AAAA…` line printed above |
| Variable | `DEPLOY_ENABLED` | `true` |

`DEPLOY_ENABLED` is the on/off switch: until it is `true` the deploy job is
skipped and merges only run CI. Set it back to `false` to pause CD.

Port 22 must be reachable from GitHub's runners, which have no fixed addresses,
so it stays open to the internet — keep password login off (Lightsail and
Ubuntu's defaults).

**Recommended:** in *Settings → Branches*, protect `main` and require the
`typecheck · lint · format · test` check to pass before merging. Without it a
red pull request can still be merged; the deploy is skipped, but `main` is broken.

