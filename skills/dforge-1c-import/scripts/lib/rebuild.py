#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
Rebuild a tenant from nothing: install every module, then load every contour.

Written the day `docker/reset.sh` wiped the tenant and the recipe turned out to live in
one person's head and one section of a status document. Both are worse than a command:
the order is computed rather than remembered, each step says what it did, and a failure
stops at the module that failed instead of leaving half a tenant behind.

    python tools/1c.py rebuild --code <tenant>              # install, then load, everything
    python tools/1c.py rebuild --code <tenant> --install    # modules only
    python tools/1c.py rebuild --code <tenant> --load       # data only
    python tools/1c.py rebuild --code <tenant> --from production   # resume at a module
    python tools/1c.py rebuild --code <tenant> --only planning     # one module, on its own
    python tools/1c.py rebuild --code <tenant> --plan       # print the order and stop

**Install-then-load is the wrong order for a register that caches its totals.** A `totals`
cache is rebuilt when the register is installed or its shape changes, and never again - there
is no rebuild command - so rows loaded afterwards never reach it and `getBalance` as of a date
comes back short with no error at all. None of the registers declared here has a `totals`
cache, which is the only reason this order is safe; the day one does, its contour has to be
loaded before the module that declares it is installed.

It does NOT create the tenant. That needs an admin user to exist first and is one
command in the platform's own CLI, which says plainly what it wants:

    curl -s -X POST http://localhost:5002/api/auth/register -H "Content-Type: application/json" \\
         -d '{"email":"...","password":"...","firstName":"...","lastName":"..."}'
    npx -y @dforge-core/dforge-cli@latest tenant create \\
         --code <code> --name <name> --admin <email>

Installing runs the platform's published CLI on this machine (tools/lib/cli.py), straight
from this repository's module directories.
"""
from __future__ import print_function

import argparse
import os
import subprocess
import sys
import time

import cli
import deps
import paths

def install_order():
	"""Every generated module, in an order where nothing precedes what it depends on."""
	sequence, stuck = deps.order(deps.graph())
	if stuck:
		raise SystemExit("rebuild: %s cannot be ordered - a cycle in the manifests"
		                 % ", ".join(sorted(stuck)))
	return [code for code in sequence
	        if os.path.isdir(os.path.join(paths.MODULES, code))]


def remote(tenant):
	"""`--url` and `--token` for an install through the running API, when DFORGE_URL is set.

	A local install writes the tenant's metadata straight to the database, and the running
	dforge-api never hears of it: it goes on serving the old action scripts and register
	bindings until its cache expires or it restarts - two engine replays on 2026-10-19 ran
	the previous code. Through the API the same request invalidates them. A new tenant has
	no session to sign in with yet, so this stays opt-in.
	"""
	url = os.environ.get("DFORGE_URL")
	if not url:
		return []
	import posting
	named = os.environ.get("DF_TENANT")
	os.environ["DF_TENANT"] = tenant
	try:
		return ["--url", url, "--token", posting.token()]
	finally:
		if named is None:
			del os.environ["DF_TENANT"]
		else:
			os.environ["DF_TENANT"] = named


def install(tenant, code, verbose=False):
	rc, out = cli.run(["module", "install", "--code", tenant,
	                   "--path", os.path.join(paths.MODULES, code), "--force"] + remote(tenant))
	if verbose:
		print(out)
	# a local install reports in prose, one through the API in JSON
	if rc != 0 or not ("installed successfully" in out or '"success":true' in out):
		tail = [line for line in out.splitlines() if line.strip()][-12:]
		raise SystemExit("rebuild: installing %s failed\n   %s"
		                 % (code, "\n   ".join(tail)))
	# The one line worth keeping from a hundred: what the registrar actually did.
	return next((l.strip() for l in out.splitlines() if "Registers:" in l), "")


def load(tenant, code, verbose=False):
	"""Copy the contour's rows. `migrate` reads the tenant's own shape, so it must run
	after the install rather than beside it.

	**The tenant has to be handed over explicitly.** `migrate` picks its target from
	`DF_TENANT`, which has no default, and it takes no tenant argument - so a `load` that
	only passed the module loaded whatever `.env` pointed at while reporting the tenant
	named on the command line. It truncates as it goes, so the wrong tenant is not a
	no-op: `rebuild --code <other> --load` emptied and reloaded whatever DF_TENANT named and left the other empty.
	"""
	command = [sys.executable, os.path.join(paths.ROOT, "tools", "1c.py"),
	           "migrate", "run", code, "--truncate"]
	# Both names, and both pinned rather than cleared. `migrate.load_env()` fills from `.env`
	# with `setdefault`, so an unset variable is not a safe default - it is an invitation:
	# clearing DF_PG_DB would let a DF_PG_DB in `.env` win over the DF_TENANT set here, and
	# the load would truncate that database while reporting this tenant.
	env = dict(os.environ, PYTHONIOENCODING="utf-8",
	           DF_TENANT=tenant, DF_PG_DB="dforge_%s" % tenant)
	proc = subprocess.Popen(command, cwd=paths.ROOT, env=env,
	                        stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
	out = proc.communicate()[0].decode("utf-8", "replace")
	if verbose:
		print(out)
	if proc.returncode != 0:
		tail = [line for line in out.splitlines() if line.strip()][-12:]
		raise SystemExit("rebuild: loading %s failed\n   %s" % (code, "\n   ".join(tail)))
	# A balance register whose journal was just reloaded has a state nothing else rebuilds:
	# 1C has no state table to copy, and the platform only moves it by posting.
	seeded = subprocess.Popen(
		[sys.executable, os.path.join(paths.ROOT, "tools", "1c.py"), "seedstate", "run", code],
		cwd=paths.ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
	seed_out = seeded.communicate()[0].decode("utf-8", "replace")
	if verbose:
		print(seed_out)
	if seeded.returncode != 0:
		raise SystemExit("rebuild: seeding the balance state of %s failed\n   %s"
		                 % (code, seed_out.strip()))
	for line in reversed(out.splitlines()):
		parts = line.split()
		if len(parts) >= 2 and parts[1] == "entities":
			return line.strip()
	return ""


def run(codes, doing, action, verbose=False):
	started = time.time()
	for index, code in enumerate(codes, 1):
		mark = time.time()
		note = action(code, verbose)
		print("   %2d/%d  %-12s %6.1fs  %s"
		      % (index, len(codes), code, time.time() - mark, note))
		sys.stdout.flush()
	print("   %s: %d module(s) in %.0fs" % (doing, len(codes), time.time() - started))


def main():
	parser = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
	parser.add_argument("--code", required=True, help="tenant code, as the platform knows it")
	parser.add_argument("--install", action="store_true", help="modules only")
	parser.add_argument("--load", action="store_true", help="data only")
	parser.add_argument("--from", dest="start", help="resume at this module")
	parser.add_argument("--only", help="this module alone, dependencies assumed installed")
	parser.add_argument("--plan", action="store_true", help="print the order and stop")
	parser.add_argument("--verbose", action="store_true")
	args = parser.parse_args()

	codes = install_order()
	if args.only and args.start:
		raise SystemExit("rebuild: --only and --from ask for different things")
	if args.only:
		# One module, after a declaration changed. Its dependencies are already installed -
		# reinstalling them would be an upgrade in place, which is safe but not free, and
		# reloading their rows would be minutes of nothing.
		if args.only not in codes:
			raise SystemExit("rebuild: %r is not one of %s" % (args.only, ", ".join(codes)))
		codes = [args.only]
	if args.start:
		if args.start not in codes:
			raise SystemExit("rebuild: %r is not one of %s" % (args.start, ", ".join(codes)))
		codes = codes[codes.index(args.start):]

	print("[i] tenant %s, modules from %s" % (args.code, paths.MODULES))
	print("[i] %d module(s): %s" % (len(codes), " -> ".join(codes)))
	if args.plan:
		return

	both = not (args.install or args.load)
	if args.install or both:
		print("\ninstalling")
		run(codes, "installed",
		    lambda code, verbose: install(args.code, code, verbose), args.verbose)
	if args.load or both:
		print("\nloading into %s" % args.code)
		run(codes, "loaded",
		    lambda code, verbose: load(args.code, code, verbose), args.verbose)


if __name__ == "__main__":
	main()
