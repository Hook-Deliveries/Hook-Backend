# Hook Backend VPS Handover

This guide covers handing the Hook API VPS to another operator and deploying it with the Docker Compose setup in this repository. It does not confirm that a VPS is currently reachable or configured.

At preparation time (2026-11-06), this local checkout is on `fix/fez-integration`, one commit behind `upstream/development`; its `origin` is a personal fork while `upstream` is `Hook-Deliveries/Hook-Backend`. Confirm which repository is authoritative before deploying, because the VPS script fetches from its `origin` remote.

## Before the walkthrough

Have these ready through the team's approved password manager or secret store:

- VPS provider, SSH host/IP, operating system, and the person who controls the provider account.
- The approved GitHub repository and the branch that is allowed to run in production.
- DNS/Cloudflare access, the production API hostname, and the Cloudflare Origin Certificate files.
- MongoDB Atlas access and the production database connection string.
- Payment, email, delivery, image storage, OAuth, and other provider accounts used by the product.
- A separate SSH key for the new operator. Do not send private keys or `.env` files in chat or email.

The new operator should use their own SSH key and named accounts. Remove old SSH keys and rotate any deployment key that was shared when a person leaves.

## Walk her through SSH

### Windows Command Prompt: connect with the key already added in Hostinger

On her Windows PC, open **Command Prompt** (not PowerShell) and run:

```cmd
ssh -o IdentitiesOnly=yes -i "%USERPROFILE%\.ssh\id_ed25519" root@153.92.222.181
```

If SSH asks for a key passphrase, she enters the passphrase she set when creating the key; it is not the VPS root password. At a first-connection host-key prompt, verify the fingerprint with Hostinger before typing `yes`. A successful login shows a remote prompt such as `root@hook-prod:~#`.

The key file `id_ed25519` is private and stays on her PC. The `.pub` file is the shareable public key. For routine project work, switch from root to the existing deployment account:

```bash
sudo -iu deploy
whoami
```

The second command should print `deploy`. Linux commands such as `cd`, `ls`, and `nano` work after SSH has connected; before that, she is still in Windows Command Prompt.

First, have her create a key on her computer (or use an existing public key):

```sh
ssh-keygen -t ed25519 -a 64 -f ~/.ssh/hook-vps -C "her-name-hook-vps"
cat ~/.ssh/hook-vps.pub
```

She should give you the displayed `.pub` line. It is okay to share that public key; **never ask for or copy her private key** (`~/.ssh/hook-vps`).

On the VPS, as an administrator, create a named Linux account for her, add her public key, then grant read/traverse access to the project using its `deploy` group. Replace `hername` and paste her complete public key line into the editor:

```sh
sudo adduser --disabled-password --gecos "" hername
sudo usermod -aG deploy hername
sudo install -d -o hername -g hername -m 700 /home/hername/.ssh
sudo install -o hername -g hername -m 600 /dev/null /home/hername/.ssh/authorized_keys
sudoedit /home/hername/.ssh/authorized_keys
sudo chown hername:hername /home/hername/.ssh/authorized_keys
sudo chmod 600 /home/hername/.ssh/authorized_keys
```

Paste her public key as one new line in `authorized_keys`; preserve any existing lines.

The project directory must be searchable/readable by the `deploy` group. Check its owner and permissions before changing them:

```sh
stat -c '%A %U:%G %n' /home/deploy /home/deploy/hook-backend
id hername
```

If `/home/deploy` itself blocks her from traversing into the project, grant only traversal on that parent directory with an ACL:

```sh
sudo setfacl -m u:hername:--x /home/deploy
```

If the project directory's group is not `deploy`, grant her membership in the actual read-only project group instead. Confirm the production `.env` is still owner-only (mode `600`). Do not add her to the `docker` group unless she is meant to have root-equivalent server access.

Check permissions as her account before she signs in:

```sh
sudo -u hername test -x /home/deploy && echo "can traverse /home/deploy"
sudo -u hername test -r /home/deploy/hook-backend && echo "can list project"
sudo -u hername test -x /home/deploy/hook-backend && echo "can enter project"
sudo -u hername test ! -r /home/deploy/hook-backend/deploy/.env && echo "environment remains private"
```

Now she connects from her computer. Replace the placeholders with the account and host you provided. Verify the VPS host-key fingerprint with the administrator or VPS provider before accepting it on first connection.

```sh
ssh -i ~/.ssh/hook-vps hername@<VPS_HOST>
```

Once connected, she can confirm her account and enter the project directory:

```sh
whoami
hostname
cd /home/deploy/hook-backend
pwd
ls
```

She can inspect Docker status if she has the required Docker permissions:

```sh
docker --version
docker compose version
git status --short --branch
git remote -v
cd deploy
docker compose ps
```

The deployment script's firewall service refers to `/home/deploy/hook-backend/deploy/firewall.sh`, so keep that project path unless the service unit is deliberately changed too. The GitHub workflow connects as the `deploy` user.

## Prepare a new Ubuntu VPS

Skip this section if Docker and the deployment account are already in place. These commands follow Docker's current Ubuntu installation instructions; confirm the VPS is a supported Ubuntu release and architecture first. Docker-published ports can bypass UFW/firewalld rules, so review the repository's Cloudflare-only firewall behavior before exposing services. [Docker installation guide](https://docs.docker.com/engine/install/ubuntu/)

```sh
sudo apt-get update
sudo apt-get install -y ca-certificates curl git
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
sudo tee /etc/apt/sources.list.d/docker.sources >/dev/null <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo adduser --disabled-password --gecos "" deploy
sudo usermod -aG docker deploy
```

The deploy script runs Docker as `deploy` and uses `sudo` to install/start the firewall service. Configure that access according to the team's server policy; a non-interactive GitHub Actions SSH session cannot answer a sudo password prompt. The `docker` group grants root-equivalent access.

The firewall service allows ports 80/443 from Cloudflare IP ranges only. Before the first deploy, confirm the DNS record is proxied through Cloudflare and that the VPS network interface is named `eth0` (the firewall script uses `eth0`). Keep SSH access allowed separately. The Nginx container expects `deploy/certs/origin.pem` and `deploy/certs/origin.key`.

## Set up the project and production environment

On a new server only, clone the repository that the team has approved for deployment. The deploy script fetches `origin`, so make sure it points to the same repository that owns the commit being deployed.

```sh
sudo install -d -o deploy -g deploy -m 0750 /home/deploy/hook-backend
sudo -iu deploy
git clone <APPROVED_REPOSITORY_URL> /home/deploy/hook-backend
```

If the directory already exists, do not clone over it. Check `git remote -v`, `git status --short --branch`, and the deployment branch with the project owner first.

Create or edit the server-only environment file. Never commit this file; `.env` files are ignored by Git.

```sh
cd /home/deploy/hook-backend/deploy
umask 077
touch .env
nano .env
chmod 600 .env
stat -c '%a %U:%G' .env
awk -F= '/^[A-Za-z_][A-Za-z0-9_]*=/{print $1}' .env | sort
```

Use one `NAME=value` entry per line. Do not run `source .env`. Generate strong values on the server with `openssl rand -hex 32`, and enter them directly into the file. The production values to confirm include:

- `NODE_ENV=production`, `PORT=4000`, `MONGODB_URI`, `APP_URL`, and `CORS_ORIGINS` (comma-separated exact frontend origins; no `*`).
- `JWT_SECRET` (at least 32 characters), `PACKAGE_CREDENTIAL_ENCRYPTION_KEY` (an independent key, at least 32 characters), `BOOTH_ACCESS_SECRET`, and `BOOTH_SESSION_SECRET` (each at least 32 characters).
- `REDIS_PASSWORD` and `RABBITMQ_PASSWORD` for the Compose-managed services. **The current local ignored `deploy/.env` key list does not include `REDIS_PASSWORD`; make sure the VPS file has it before starting the stack.**
- `PAYSTACK_SECRET_KEY` and `GOOGLE_WEB_CLIENT_ID` are required by production validation. Cloudinary values are required unless the corresponding media features are explicitly disabled.
- Add provider credentials (Fez, Monnify, Brevo, Azure OpenAI, push notifications, etc.) only when those integrations are enabled and in use.

The full variable reference is [.env.example](../.env.example). Production startup checks are in [src/config/env.ts](../src/config/env.ts), and Compose-specific settings are in [deploy/docker-compose.yml](../deploy/docker-compose.yml). Keep production credentials in the team's secret store and transfer them directly to the server.

Copy the Cloudflare Origin Certificate and its private key to the expected paths using a secure channel. On the VPS:

```sh
mkdir -p /home/deploy/hook-backend/deploy/certs
chmod 700 /home/deploy/hook-backend/deploy/certs
```

From the operator's computer, copy the certificate and key to their expected filenames (replace the local file paths):

```sh
scp -i ~/.ssh/hook-vps <ORIGIN_CERT_FILE> <SSH_USER>@<VPS_HOST>:/home/deploy/hook-backend/deploy/certs/origin.pem
scp -i ~/.ssh/hook-vps <ORIGIN_KEY_FILE> <SSH_USER>@<VPS_HOST>:/home/deploy/hook-backend/deploy/certs/origin.key
```

Then on the VPS, restrict access to the private key:

```sh
chmod 600 /home/deploy/hook-backend/deploy/certs/origin.pem /home/deploy/hook-backend/deploy/certs/origin.key
```

## Deploy manually

First confirm with the owner which branch/commit is approved. The script only accepts `origin/main`, `origin/development`, or a commit SHA, and it force-checks out that ref in the server checkout.

```sh
cd /home/deploy/hook-backend/deploy
./deploy.sh origin/main
```

For development, the script expects a separate checkout at `/home/deploy/hook-dev` with its own `deploy/deploy.sh` and environment. Do not use the development command until that server setup exists:

```sh
cd /home/deploy/hook-backend/deploy
./deploy.sh "dev origin/development"
```

The script builds the API image, starts Redis and RabbitMQ, rolls out the API replicas, workers, and consumers, then reloads Nginx. It also enables the Cloudflare-only firewall service. It does not run a MongoDB migration or seed data automatically.

Check deployment status and the public health endpoint after rollout:

```sh
cd /home/deploy/hook-backend/deploy
docker compose ps
curl -fsS https://<PRODUCTION_API_HOST>/health
docker compose logs --tail=100 api-1
```

Do not paste logs into a public channel; review and redact customer data, tokens, and provider details first.

## Configure GitHub Actions deployment

The repository already contains `.github/workflows/deploy.yml`. It deploys after successful CI on `main` and `development`, and also supports manual dispatch. It connects as `deploy` and reads these repository secrets:

- `DEPLOY_HOST`: VPS hostname or IP (no `ssh://` prefix).
- `DEPLOY_SSH_KEY`: private key for the dedicated GitHub Actions deploy key. Install only its public half on the VPS.
- `DEPLOY_KNOWN_HOSTS`: verified SSH host-key line(s) for that VPS. Get the key with `ssh-keyscan`, then verify its fingerprint with the provider/admin before saving it.

Add them under the GitHub repository's **Settings → Secrets and variables → Actions**. [GitHub's secrets guide](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets)

For a new Actions key pair, generate it on an authorized operator's computer and keep the private file private:

```sh
ssh-keygen -t ed25519 -f ~/.ssh/hook-actions-deploy -C "hook-github-actions-deploy" -N ""
```

Save the contents of `~/.ssh/hook-actions-deploy` as `DEPLOY_SSH_KEY`; install only `~/.ssh/hook-actions-deploy.pub` on the VPS using the restricted key line below. For the host-key secret, `ssh-keyscan -H <VPS_HOST>` produces candidate known-hosts lines; verify the fingerprint with the provider/admin before saving the result as `DEPLOY_KNOWN_HOSTS`.

Important: the workflow runs SSH with the remote command set to the commit SHA (or `dev <SHA>`). The repository does not include the VPS-side SSH command dispatcher or the restricted `authorized_keys` command setting. Verify with the server administrator that this dispatcher exists and routes only approved commit SHAs to the correct deploy script. Without it, do not assume a green CI run means the VPS deployed; check the Deploy workflow run and the live health endpoint.

If the VPS has no equivalent dispatcher, create one as root after confirming the repository path and development checkout path. This accepts only 40-character commit SHAs and the workflow's `dev <SHA>` form:

```sh
sudo tee /usr/local/sbin/hook-deploy-dispatch >/dev/null <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
request=${SSH_ORIGINAL_COMMAND:-}
if [[ "$request" =~ ^dev\ ([0-9a-f]{40})$ ]]; then
  exec /home/deploy/hook-backend/deploy/deploy.sh "dev ${BASH_REMATCH[1]}"
elif [[ "$request" =~ ^[0-9a-f]{40}$ ]]; then
  exec /home/deploy/hook-backend/deploy/deploy.sh "$request"
else
  echo "unsupported deploy request" >&2
  exit 64
fi
EOF
sudo chown root:root /usr/local/sbin/hook-deploy-dispatch
sudo chmod 755 /usr/local/sbin/hook-deploy-dispatch
```

Install the GitHub Actions **public** key in `/home/deploy/.ssh/authorized_keys` as a restricted key (keep any existing operator keys intact). Use this as the beginning of its single line, followed by the public key text:

```text
command="/usr/local/sbin/hook-deploy-dispatch",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty ssh-ed25519 <GITHUB_ACTIONS_PUBLIC_KEY>
```

The `dev` route requires `/home/deploy/hook-dev/deploy/deploy.sh` and its environment to exist. Validate a production deployment path first; don't enable the development route until that separate checkout is ready.

## Updating environment values later

Main and development use separate checkouts and separate environment files:

- Main: `/home/deploy/hook-backend/deploy/.env`
- Development: `/home/deploy/hook-dev/deploy/.env`

The development checkout and environment are not confirmed to exist just because main exists. Check the target file first; if it is missing, stop rather than creating a blank `.env`.

From a root SSH session, switch to the deployment account so the file stays owned by `deploy`:

```bash
sudo -iu deploy
```

For main, verify the existing file before editing it:

```sh
cd /home/deploy/hook-backend/deploy
if [ -f .env ]; then ls -l .env; else echo "Main .env is missing; stop and report this"; fi
```

Only if the existing `.env` was listed, edit it:

```sh
nano .env
chmod 600 .env
stat -c '%a %U:%G %n' .env
```

Edit the existing entries in `nano`; do not create duplicate variable names. For the requested Hook web URLs, use `PAYMENT_WEB_ORIGIN=https://app.hook.africa` and `PUBLIC_WEB_URL=https://app.hook.africa`. Set the Cloudinary entries (`CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`, `CLOUDINARY_UPLOADS_ENABLED`, `CLOUDINARY_UPLOAD_FOLDER`, and `CLOUDINARY_UPLOAD_PRESET`) there too. Enter API credentials directly in the editor, never as command arguments, chat messages, or screenshots. Keep screen sharing paused while secrets are visible.

You can verify that the non-secret values are right and that credentials are present without printing the secrets:

```sh
grep -E '^(CLOUDINARY_CLOUD_NAME|CLOUDINARY_UPLOADS_ENABLED|CLOUDINARY_UPLOAD_FOLDER|CLOUDINARY_UPLOAD_PRESET|PAYMENT_WEB_ORIGIN|PUBLIC_WEB_URL)=' .env
for name in CLOUDINARY_API_KEY CLOUDINARY_API_SECRET; do grep -q "^${name}=." .env && echo "$name is set" || echo "$name is missing"; done
```

Recreate the main app processes so they read the updated environment, then check their status:

```sh
docker compose up -d --force-recreate api-1 api-2 api-3 worker consumer-payments consumer-orders consumer-fulfilment
docker compose ps
```

Repeat the edit and recreate steps separately in development only after confirming `/home/deploy/hook-dev/deploy/.env` exists and is the correct development checkout. Before running Compose there, inspect the non-secret isolation settings:

```sh
cd /home/deploy/hook-dev/deploy
if [ -f .env ]; then ls -l .env; else echo "Development .env is missing; stop and report this"; fi
```

The Compose file defaults to project name `hook`, image `hook-api`, and an Nginx container binding ports 80 and 443. If main and development are both running, development needs its own Compose project name and image, a distinct API port, and must not try to start a second Nginx on the same ports. If these settings or the development proxy route are unclear, pause and confirm the server layout before running `docker compose up`; otherwise a dev operation could collide with main.

After confirming the existing development `.env` is present, inspect only its non-secret isolation settings:

```sh
grep -E '^(COMPOSE_PROJECT_NAME|API_IMAGE|API_PORT|API_BIND|SKIP_NGINX)=' .env
```

Once development isolation is confirmed and `.env` is edited, recreate only that development stack from its own directory:

```sh
docker compose up -d --force-recreate api-1 api-2 api-3 worker consumer-payments consumer-orders consumer-fulfilment
docker compose ps
```

Cloudinary behavior in this backend: catalog media uploads are signed and require `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, and `CLOUDINARY_API_SECRET`; they do not use the upload preset. The general media upload route uses signed uploads when the key and secret are present and falls back to the unsigned preset only when they are absent. `CLOUDINARY_UPLOADS_ENABLED` currently gates startup validation; `CATALOG_SIGNED_MEDIA_ENABLED` controls the signed catalog-media route. After editing either environment file, recreate that environment's API containers; a plain `docker compose restart` does not reload changed environment values. `PUBLIC_WEB_URL` is documented for the requested configuration but is not currently read by backend code. `PAYMENT_WEB_ORIGIN` is read when generating hosted payment links.

To diagnose a running environment without printing credentials, run these commands from that environment's deployment directory. Repeat them separately for main and development:

```sh
docker compose ps
docker compose exec -T api-1 node -e 'for (const n of ["CLOUDINARY_CLOUD_NAME","CLOUDINARY_API_KEY","CLOUDINARY_API_SECRET"]) console.log(n+": "+(process.env[n]?"set":"missing"))'
docker compose exec -T api-1 node -e 'const h=require("https");const u="https://api.cloudinary.com/v1_1/"+process.env.CLOUDINARY_CLOUD_NAME+"/ping";const q=h.get(u,{auth:process.env.CLOUDINARY_API_KEY+":"+process.env.CLOUDINARY_API_SECRET,timeout:7000},r=>{console.log("Cloudinary HTTP "+r.statusCode);r.resume()});q.on("timeout",()=>q.destroy(new Error("timeout")));q.on("error",e=>console.log("Cloudinary request failed: "+(e.code||e.message)))'
```

If credentials are missing in the container, the env file was edited in the wrong folder or the app container was not recreated. A `Cloudinary HTTP 200` confirms the signed API ping succeeded; a timeout means the app container could not reach the API, so check the Docker firewall before changing credentials. Never paste `.env` contents or unsanitized logs into chat.

### Cloudinary and Docker firewall fix

On 10 November 2026, the VPS environment values were present in both running stacks and a signed Cloudinary ping from the VPS host returned HTTP 200. App containers timed out to Cloudinary even though general HTTPS worked. The `HOOK-CF` drop counter increased during a failed API request. The cause was `deploy/firewall.sh`: the Cloudflare-only filter was also dropping established reply packets for outbound container requests.

The script now adds IPv4 and IPv6 `ESTABLISHED,RELATED` return rules ahead of the Cloudflare source filters, and appends those filters after the return rules. New inbound connections on ports 80 and 443 remain Cloudflare-only. After deploying the updated script, reload the service from either SSH root or the `deploy` account:

```sh
sudo systemctl restart hook-firewall
sudo iptables -S DOCKER-USER
sudo ip6tables -S DOCKER-USER
```

The established-connection rules must appear before the `HOOK-CF` rules. The signed Cloudinary API ping, public image fetch, and a temporary signed image upload returned HTTP 200 in both main and development after the correction; the temporary test images were deleted. Main and development health endpoints also returned HTTP 200.

### Paystack and Monnify callback/webhook URLs

Set the callback URL variables in each server `.env` file. In the provider dashboards, configure the separate webhook URL. A callback sends the shopper back to Hook after checkout; a webhook sends payment events from the provider to the backend. Both server environments currently use Paystack test credentials and Monnify sandbox mode; replace the main server credentials with live provider credentials before accepting real payments.

| Environment | Provider | Checkout callback | Provider webhook |
|---|---|---|---|
| Main API | Paystack | `https://api.hookapp.tech/api/v1/payments/paystack/callback` | `https://api.hookapp.tech/api/v1/webhooks/paystack` |
| Main API | Monnify | `https://api.hookapp.tech/api/v1/payments/monnify/callback` | `https://api.hookapp.tech/api/v1/webhooks/monnify` |
| Development API | Paystack | `https://dev-api.hookapp.tech/api/v1/payments/paystack/callback` | `https://dev-api.hookapp.tech/api/v1/webhooks/paystack` |
| Development API | Monnify | `https://dev-api.hookapp.tech/api/v1/payments/monnify/callback` | `https://dev-api.hookapp.tech/api/v1/webhooks/monnify` |

Set `PAYSTACK_CALLBACK_URL` and `MONNIFY_CALLBACK_URL` to the matching environment's callback. `APP_URL` should use that environment's API host as a fallback. Do not point a live provider account at the development URLs.

Changing `REDIS_PASSWORD` or `RABBITMQ_PASSWORD` needs a coordinated service credential rotation; schedule it with the owner because these services keep persistent data and all clients must use the same new credentials. Do not remove Docker volumes as part of routine deployment or troubleshooting.

## Handover sign-off

- The new operator can SSH with their own key and can identify the VPS and project directory.
- The production repo/remote and deploy branch are confirmed with the owner.
- The operator can find the secret store and provider accounts; secrets are not copied into this document or Git.
- Production `.env` and certificate file permissions are restricted.
- GitHub Actions secrets and the VPS SSH dispatcher have been verified by the owner.
- A deployment has completed, `docker compose ps` is healthy, and `https://<PRODUCTION_API_HOST>/health` responds successfully.
- The owner records who retains server, DNS, database, payment, and deployment-key access.
