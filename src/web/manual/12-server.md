# Running Meridian on a server

Meridian is a desktop application by default: it runs on your computer, keeps
your company file there, and nothing leaves the machine. That is the right
answer for one person.

For a team, one machine holds the data and everybody else connects to it. That
machine is yours — a computer in your office, or a server you rent. There is no
Meridian cloud to sign up for.

## Choosing the machine

Anything that stays on. Meridian is a single process with no dependencies; a
small office server, a NAS that runs Node, or a modest cloud instance is
plenty. What matters is that it stays on, that it is backed up, and that the
people who need it can reach it.

## Starting a server

On the machine that will hold the data:

```
npm run server
```

It binds every network the machine is on, prints the addresses it can be
reached at, and stays in the foreground. Options:

```
node src/server.mjs --server --port 8422 --data /var/lib/meridian
node src/server.mjs --server --tls-cert /etc/ssl/meridian.crt --tls-key /etc/ssl/meridian.key
```

Everything can also be set in the configuration file — see below — so that a
plain `--server` does the right thing.

## Running it as a service

So that it starts at boot and nobody has to leave a terminal open:

```
node scripts/service.mjs install
node scripts/service.mjs status
node scripts/service.mjs uninstall
```

It writes a launchd agent on macOS, a systemd unit on Linux, or a scheduled
task on Windows, and prints the file before installing it so you can see
exactly what will run. `node scripts/service.mjs print` shows it without
installing anything.

On Linux, `--system` installs for the whole machine rather than your account;
without it, run `loginctl enable-linger $USER` so the service runs when you are
not logged in.

## Connecting the other computers

On each person's machine, install Meridian as usual, then open
**Settings → Connection**, choose **On a server**, and enter the address the
server printed. Use **Test the connection** to check it before saving. Quit and
reopen.

That machine now keeps no company data of its own. Everybody works on the same
file, sees the same numbers, and their permissions are the ones their role
gives them.

## The configuration file

The three questions that have to be answered before there is a database to
read live in a small JSON file beside the data — `meridian.json`. Its path is
shown under Settings → Connection.

```json
{
  "mode": "server",
  "remote": { "url": "", "verify_tls": true },
  "server": {
    "host": "0.0.0.0",
    "port": 8422,
    "tls": { "cert": "", "key": "" },
    "trust_proxy": false
  }
}
```

`mode` is `local` (this machine runs it and holds the data), `remote` (this
machine is a client) or `server` (this machine serves everybody). A flag on the
command line always wins over the file.

## Security

**Use TLS.** Without it, sign-ins and data cross the network in the clear.
Either give Meridian a certificate and key directly, or put it behind a reverse
proxy that terminates TLS and set `trust_proxy` so client addresses are logged
correctly.

**Do not expose it to the open internet** without thinking hard. A VPN, or a
proxy you control with its own authentication in front, is the sane approach.
Meridian rate-limits sign-in attempts and locks an account after repeated
failures, but it is not designed to be a public-facing service.

**Back it up**, and check that a backup restores. A backup nobody has tested is
a hope.

**Give people the role they need.** The five permission levels and the
row-level restrictions exist so a warehouse supervisor cannot open the payroll.

## Ports and firewalls

Meridian listens on one TCP port, 8422 by default. Open it between the server
and the machines that need it, and nowhere else. `/health` answers without
authentication and returns nothing but a version, which is useful for a load
balancer or a monitor.
