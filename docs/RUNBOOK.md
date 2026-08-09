# Runbook — bringing Syl up on the Mac

This is the half of `syl-007` that needs your hands: `sudo`, an Apple ID, the
Tailscale admin console, and the phone. Nothing here can be automated, and
everything here has been left undone deliberately rather than forgotten.

Assume you are reading this months from now having forgotten all of it. Every
step says **what to run**, **what it proves**, and **how you know it worked**.
Run them in order — several of the later ones only work because an earlier one
did.

There is one command you will use constantly:

```sh
bash scripts/syl-verify.sh status
```

It checks every mechanical precondition on this list and prints PASS or FAIL for
each. Run it now, before anything else, to see the shape of what is missing. Run
it after every step. When it prints "Everything checked passed", the machine is
ready and only the phone is left.

---

## The one thing to understand before you start

**Syl runs as a LaunchAgent, not a LaunchDaemon, and that forces automatic
login.**

The obvious design for "starts before anyone logs in" is a `LaunchDaemon` in
`/Library/LaunchDaemons`. It is wrong here, for a reason specific to this
system: the `claude` CLI keeps its subscription credentials in the **login
keychain**, which is locked until your account logs in.

```sh
security find-generic-password -s "Claude Code-credentials"
# keychain: "/Users/Reason/Library/Keychains/login.keychain-db"
```

A daemon starting at boot would come up perfectly, bind its port, answer every
health check — and fail every single turn, because it cannot read that keychain.
The first non-negotiable constraint is that Syl bills the claude.ai subscription
and never the metered API, so "start earlier and lose the credentials" is not a
trade that is available.

So the service is an agent, and "survives a reboot with nobody present" is
bought with **automatic login** (step 3). One consequence, and you should decide
it on purpose:

> **FileVault must stay off** for a power cut to recover unattended. With
> FileVault on, a cold boot stops at a pre-boot unlock screen and nothing in
> this repository can get past it. It is currently off (`fdesetup status`).

---

## 1. Preflight

```sh
cd /Users/Reason/code/ai/syl
node --version            # must be v22 or newer
npm install
npm run verify            # typecheck + the whole suite
npm run build             # the service runs built output, not tsx
```

**Proves**: the tree is sound and `backend/dist/index.js` exists.
**Worked if**: `verify` is green and `ls backend/dist/index.js` finds a file.
`scripts/syl-service.sh` refuses to start with exit 78 and a message naming
`npm run build` if that file is missing, so a forgotten build is loud rather
than mysterious.

---

## 2. Power settings — `syl-007.1.1`

```sh
sudo pmset -c sleep 0
sudo pmset -c autorestart 1
pmset -g custom | head -30
```

**Proves**: the Mac stays awake, and comes back by itself after a power cut.

`sleep 15` is the current setting, and a sleeping Mac fires no reminders — the
07:00 agenda arrives whenever somebody touches the trackpad. `autorestart 0` is
worse: after a power cut the machine stays **off** until a human presses the
button, and no amount of software supervision helps because there is nothing
running to supervise.

**Worked if**: `pmset -g custom` shows `sleep 0` and `autorestart 1` under
`AC Power`, and `scripts/syl-verify.sh status` passes its first two checks.

The service also checks this at every startup and warns if it has drifted — an
OS update or a migration assistant resets these silently, and the service is the
only thing that runs after all of those.

---

## 3. Automatic login

System Settings → Users & Groups → Automatic login → your account.

Or:

```sh
sudo defaults write /Library/Preferences/com.apple.loginwindow autoLoginUser "$(whoami)"
```

(The GUI is safer: it also writes the `/etc/kcpassword` file macOS needs. If you
use the command line, set it in the GUI as well.)

**Proves**: after a reboot, a user session exists — so LaunchAgents run and the
login keychain is unlocked.

**Worked if**: `defaults read /Library/Preferences/com.apple.loginwindow
autoLoginUser` prints your username, and — the real test — step 10's reboot
brings Syl back with nobody touching the machine.

---

## 4. Tailscale — `syl-007.1.2`

Install the **standalone** client from <https://tailscale.com/download/mac>.
**Not the Mac App Store build.**

The standalone variant runs `tailscaled` as a real system daemon that starts at
boot. The App Store variant is sandboxed and needs an interactive sign-in. For a
machine expected to survive an unattended reboot only one of those is
acceptable. **Do not install both** — they conflict.

```sh
which tailscale                 # expect /usr/local/bin/tailscale
tailscale status
tailscale status --json | grep -i dnsname   # note this hostname; step 6 needs it
```

**Proves**: the tailnet is up and this node has a name.
**Worked if**: `tailscale status` lists this Mac and the phone.

> There is currently **no tailscale binary on this machine at all**. Everything
> in steps 4–6 is untried here; the renewal automation has only ever run against
> a stub.

---

## 5. Key expiry and the phone — `syl-007.1.3`

In the Tailscale admin console (<https://login.tailscale.com/admin/machines>):

- **Disable key expiry on this Mac's node.** The default is 180 days and expiry
  **breaks connectivity** — Syl would silently fall off the network twice a
  year, with no symptom but the phone saying "cannot connect".
- **Leave key expiry enabled on the phone.** Re-authenticating there is one tap.

On the phone, in the Tailscale app: **VPN On Demand → Always**, for both Wi-Fi
and cellular. Since Tailscale 1.48 the iOS network extension does not stay
resident, so a tunnel triggered by hostname has a real race — the first request
can time out while the tunnel is still establishing. "Always" keeps it up rather
than triggering per request.

**Proves**: the tailnet does not expire, and the phone is on it before it needs
to be.

**Worked if — and this is the test everybody skips**: turn Wi-Fi **off** on the
phone, and load Syl over cellular. If that works, the whole network path works.
If you only ever test on the house Wi-Fi you have tested nothing.

---

## 6. HTTPS on the tailnet — `syl-007.1.4`

```sh
export SYL_TAILNET_HOSTNAME=<the DNSName from step 4, without the trailing dot>
bash scripts/syl-cert-renew.sh
cat ~/.syl/cert-status.json
```

**Proves**: `tailscale cert` issues a real, publicly-trusted Let's Encrypt
certificate for this Mac's tailnet hostname — which is why the iOS app needs
**no App Transport Security exception**. Do not reach for plain HTTP with an ATS
exception; this is free and better.

**Worked if**: `~/.syl/cert-status.json` says `"ok": true` with
`daysRemaining` around 89, and the certificate is in `~/.syl/certs/`.

The renewal is automated from step 7 onward (`com.jmm.syl.cert`, daily at 03:40
and at every load). It is a **90-day** certificate and `tailscale cert` does
**not** renew it on its own; an expired one is a silent outage on a timer. The
script renews at 30 days remaining, refuses to call a renewal successful if the
certificate on disk still expires within 14 days, and writes the status file the
service's `/health` reads — so an expiring or failed certificate shows up as
`degraded` long before it becomes an outage, and a renewal job that has *stopped
running* shows up too.

---

## 7. Push credentials — `syl-007.3.2`

Five environment variables. **Do not generate a new APNs key**: the existing
`.p8` covers Syl — one key serves every app in the team, and Apple's hard limit
is **two keys per team**, both of which are already spent. Only the bundle id
differs.

The key lives in the repo root, `git`-ignored by extension and `chmod 600`.

```sh
cd "$(git rev-parse --show-toplevel)"

export SYL_APNS_KEY_ID=XXTN5423K8
export SYL_APNS_TEAM_ID=2BRYAM5Q52
export SYL_APNS_BUNDLE_ID=com.jmm.syl
export SYL_APNS_PRIVATE_KEY="$(cat ./AuthKey_XXTN5423K8.p8)"
export SYL_APNS_ENVIRONMENT=production
```

**`SYL_APNS_BUNDLE_ID` is `com.jmm.syl`, not `com.jmm.adjutant`.** Same team,
same key, same everything else — copying that one line unchanged from the other
project's config is the easiest mistake on this page, and it fails as an
authentication error on every send.

The path is **relative**, so moving the project does not break this page. That
is also why the `cd` above is part of the snippet rather than an assumption:
`$(cat ./…)` resolves against **your shell's** working directory, so running
these lines from somewhere else silently exports an empty key. `git rev-parse
--show-toplevel` works from anywhere inside the checkout.

Relative is safe here for a reason worth stating: `SYL_APNS_PRIVATE_KEY` holds
the key's **contents**, not its location. Once exported, nothing ever resolves
that path again — the value is written into the plist, and the running service
has no idea where the file was. (The other project stores a *path* instead,
which is why it needs `../AuthKey_…`; do not copy that shape here. A relative
path means nothing to a launchd job, whose working directory is not yours.)

`SYL_APNS_ENVIRONMENT` is not optional, and the service **refuses to start**
without it in production. TestFlight and App Store builds produce **production**
device tokens; Xcode-installed builds produce **sandbox** ones. A mismatch
answers `BadDeviceToken` on every send — which is correctly treated as a dead
token, so the device is unregistered and every subsequent reminder is lost too.
One wrong word here silently and permanently ends push, with no other symptom.

Since the app you install comes through TestFlight, the answer is `production`.
If you are ever deliberately running against an Xcode build, set
`SYL_APNS_ALLOW_SANDBOX=1` as well, so it is a decision rather than an accident.

Adjutant pins its entitlement to `development` while shipping through
TestFlight. Do not inherit that.

**Worked if**: step 8's plists contain all five values.

---

## 8. Install the launchd jobs — `syl-007.2.1`

With the variables from step 7 still exported in this shell:

```sh
npm run launchd -- --install --host "$SYL_TAILNET_HOSTNAME"
```

It writes three plists into `~/Library/LaunchAgents` and prints the `launchctl`
lines to run.

> The core plist **contains the `.p8`**, because that is how launchd hands the
> service its environment. It is written `0600` for that reason. If you ever
> copy, back up or share one of these files, you are copying an Apple signing
> key. `ls -l ~/Library/LaunchAgents/com.jmm.syl.core.plist` should show
> `-rw-------`.

Run them:

```sh
launchctl bootout  gui/$(id -u)/com.jmm.syl.core 2>/dev/null || true
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.jmm.syl.core.plist
launchctl enable   gui/$(id -u)/com.jmm.syl.core
# ...and the same three for com.jmm.syl.watchdog and com.jmm.syl.cert
```

(`bootout` first: `bootstrap` on an already-loaded label fails with
`Bootstrap failed: 5: Input/output error`, which says nothing at all about the
cause.)

The three jobs and why there are three:

| Label | What it does | Why it exists |
| --- | --- | --- |
| `com.jmm.syl.core` | `RunAtLoad`, `KeepAlive`, `ThrottleInterval 10` | Starts Syl and restarts her if she **dies** |
| `com.jmm.syl.watchdog` | `StartInterval 60` | Restarts her if she **wedges** — running, holding the port, answering nothing. launchd cannot see this, and it is the 3am failure |
| `com.jmm.syl.cert` | daily 03:40 + `RunAtLoad` | Renews the 90-day certificate before it expires |

**Proves**: the service is supervised, in both of the two ways it can fail.
**Worked if**:

```sh
bash scripts/syl-verify.sh status
```

prints PASS for every check, including `http://127.0.0.1:8888/api/v1/health
answers`.

Then read the startup line:

```sh
npm run logs -- --event service.start
```

It says `credentialSource=none subscriptionRails=true`. **If it ever says
anything else, stop.** That is the invariant that costs real money: a set
`ANTHROPIC_API_KEY` silently outranks the claude.ai login and reroutes billing
to the metered API.

---

## 9. The app — `syl-007.3.1`

Follow `ios/README.md` § Releasing. In short: prove a Release build compiles
locally, bump `MARKETING_VERSION` in `ios/Syl.xcodeproj/project.pbxproj`, push
to main. The six GitHub secrets are the ones Adjutant already uses; the one
manual step is adding `com.jmm.syl` to the match repository by running
`bundle exec fastlane sync_certs` locally once with `MATCH_READONLY` unset.

Expect the first run to fail on something environmental. That is what a first
run is for.

Then, on the phone: install from TestFlight and open it. A fresh install has no
credential, so the first screen is the pairing screen — two fields, a server
address and eight digits. Get both from the Mac:

```sh
SYL_DB_PATH=~/.syl/syl.db npm run pair
```

**Set `SYL_DB_PATH`, or run it from a shell that already has it.** The service
gets that variable from its launchd plist as an absolute path; an interactive
shell does not have it, and the fallback is `.syl/syl.db` *relative to the
working directory*. A code written into the wrong store is a valid code for a
database nothing is serving, and the only symptom is "that pairing code was not
accepted" — forever, with the command reporting success every time. The command
refuses outright rather than creating a store, and prints the one it used on
every run, so check that line matches:

```sh
launchctl print gui/$(id -u)/com.jmm.syl | grep SYL_DB_PATH
```

It prints the code, when it expires, and the exact URL to type into the app
(read from the tailnet certificate's own hostname, so it is the address the
phone can actually reach over TLS). Run it whenever a device needs pairing: a
second phone, a reinstall onto a restored device, a token that was revoked.

The first boot on a machine with nothing paired also prints a code in the
startup log, which is the same thing arriving earlier:

```sh
npm run logs -- --event service.notice | grep -i pairing
```

A code lasts ten minutes, pairs exactly one device, and is superseded the
moment another is issued. If the app says the code **expired** or was **already
used**, run `npm run pair` again — retyping the old one will never work. If it
says it could not **reach** the Mac, the code is not the problem: check
Tailscale on both ends and the address in the first field.

**Worked if**: `/health` reports the `apns-environment` check as `ok`, and the
device appears in the store. If it says `degraded` and names a device from the
other channel, the app was installed from Xcode rather than TestFlight — see
step 7.

---

## 10. Proof of life — `syl-007.4.2`

Three checks, in this order. The first two are scripted.

```sh
# Kill it. KeepAlive should bring it back as a different pid.
bash scripts/syl-verify.sh kill

# Wedge it. SIGSTOP leaves the process alive, holding the port, answering
# nothing — launchd calls that perfectly healthy. Only the watchdog notices.
# Takes up to five minutes: three misses at sixty seconds, plus the restart.
bash scripts/syl-verify.sh wedge
```

**Worked if**: both print `PASS` and a *new* pid. If `wedge` fails, the watchdog
is not loaded — `launchctl print gui/$(id -u)/com.jmm.syl.watchdog`.

Then the one nobody can automate:

```sh
sudo reboot
```

**Do not log in.** Wait two minutes, then from another machine or from the
phone:

```sh
ssh <the Mac> 'bash /Users/Reason/code/ai/syl/scripts/syl-verify.sh after-reboot'
```

**Worked if**: the tailnet is up, the service answers, and — the clause that
actually fails in practice — **the phone can reach her over cellular with Wi-Fi
off**.

For the power cut: pull the plug, put it back. `autorestart 1` from step 2 is
what makes the machine come back at all; everything after that is the same path
as the reboot.

---

## 11. The acceptance criterion — `syl-007.4.1`

> Syl wakes up on her own, sends the Commander something at the right wall-clock
> moment, on his phone — and survives a reboot, a sleep/wake cycle, and a power
> cut.

One evening, from the phone, set a reminder for the following morning. Leave the
machine alone overnight.

**Worked if**: it arrives on the phone at the correct wall-clock instant, you
acknowledge it, and it is marked delivered. **Do not simulate this with a clock
override.** The whole point is that the real machine, the real network and the
real Apple infrastructure all behaved.

Until that has happened once, the epic is not done, regardless of how many beads
are closed.

---

## When something is wrong

Start here, always:

```sh
bash scripts/syl-verify.sh status   # what is broken
npm run logs -- --failure           # the most recent warning or error
npm run logs -- --level warn        # everything that has gone wrong lately
```

Logs live in `~/Library/Logs/Syl`. `syl.log` is JSON, one record per line,
rotated at 8 MiB with five kept. `launchd-*.log` are what launchd captured —
launchd holds those open, so they cannot be rotated by renaming; the watchdog
truncates them in place when they pass 32 MiB.

| Symptom | Almost certainly | Fix |
| --- | --- | --- |
| Reminders stop arriving, no error anywhere | APNs environment mismatch. Every send answers `BadDeviceToken`, the device is unregistered, and nothing says why | Check `/health`'s `apns-environment` check. Set `SYL_APNS_ENVIRONMENT=production` for a TestFlight build. Re-pair the phone |
| Phone says "cannot connect", service is up | The tailnet certificate expired, or the node's key expired | `cat ~/.syl/cert-status.json`; `bash scripts/syl-cert-renew.sh`; check key expiry is still disabled in the admin console |
| Service answers nothing but is "running" | Wedged | `bash scripts/syl-verify.sh wedge` to confirm the watchdog handles it; `launchctl kickstart -k gui/$(id -u)/com.jmm.syl.core` to fix it now |
| Nothing at all after a reboot | Automatic login is off, or FileVault is on | Steps 3 and the note at the top |
| `service.start` says `credentialSource=ANTHROPIC_API_KEY` | Something exported a key into the service's environment | Remove it from the plist and from your shell profile. This is billing, not a warning |
| Crash loop, exit 78 | Bad configuration — an offset instead of an IANA zone, an unbuilt `dist/`, a missing `SYL_APNS_ENVIRONMENT` | `npm run logs -- --level error`; the message names the variable |
| Nothing has been logged since a certain hour | The service died in a way `KeepAlive` could not fix, or the whole machine slept | `launchctl print gui/$(id -u)/com.jmm.syl.core`; `pmset -g custom` |

### Restarting by hand

```sh
launchctl kickstart -k gui/$(id -u)/com.jmm.syl.core
```

`kickstart -k` kills the current instance and starts a new one. `launchctl
start` alone is a no-op on a job launchd already believes is running — which is
exactly the wedged case.

### Turning everything off

```sh
for label in core watchdog cert; do
  launchctl bootout "gui/$(id -u)/com.jmm.syl.$label"
done
```

---

## Stopping her, and how to insist

```sh
launchctl kickstart -k gui/$(id -u)/com.syl.service   # restart, the normal way
launchctl bootout gui/$(id -u)/com.syl.service        # stop until next login
kill -9 <pid>                                         # guaranteed, uncatchable
```

`SIGTERM` and `SIGINT` are both trapped and drain in-flight work first. A
shutdown that will not finish is bounded twice over: the service abandons its
own close after 15 seconds and exits saying why, and launchd escalates to
`SIGKILL` at 20 regardless. So she cannot hang forever.

**A repeated `SIGTERM` is deliberately ignored, and a repeated `SIGINT` is
deliberately honoured.** That asymmetry is not an oversight:

- **launchd re-sends `SIGTERM`** to a job it is stopping, as a matter of course.
  A repeat therefore carries no intent, and acting on it would kill the service
  mid-write on every ordinary reboot — abandoning a job lease in a state
  indistinguishable from a crash. Repeats are swallowed.
- **Nothing auto-repeats `SIGINT`.** It comes from a terminal, so a second
  Ctrl-C is unambiguously a person who has decided not to wait. It abandons the
  close and exits `130` immediately.

So: **Ctrl-C twice** when you are running her by hand and mean it, **`kill -9`**
when you want a guarantee. Do not reach for repeated `SIGTERM` — it is the one
signal that will not do what you want.

## What is checked automatically, and what is not

Automated, in `npm run verify`:

- `SIGTERM` and `SIGINT` are trapped, in-flight work is drained, the process
  exits 0, and it says so in the log. Run against the real spawned process.
- The watchdog restarts a genuinely wedged process (a real Node process with a
  blocked event loop holding a real port) and leaves a healthy one alone.
- The certificate renewal script, run for real against a stub `tailscale` that
  issues genuine certificates — including the case where `tailscale cert` exits
  zero and leaves a certificate that still expires too soon.
- Every plist, linted by `plutil` and read back.
- The APNs environment assertion, on the real `startSyl` path.
- `pmset` parsing, against output captured from this machine.

**Never executed here**, and therefore first run by you:

- `tailscale` anything. No tailscale binary exists on this machine.
- A real push to Apple, from a real device token.
- launchd itself. The plists are validated by `plutil`, but no Syl job has ever
  been loaded.
- The reboot, the sleep/wake cycle and the power cut.
