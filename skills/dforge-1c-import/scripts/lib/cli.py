# -*- coding: utf-8 -*-
"""The platform's own CLI, run on this machine: `npx -y @dforge-core/dforge-cli@latest`.

The same command the editor extension runs, so what it installs and what it reports are
what the editor would install and report - no copy of the CLI baked into a container image
that can lag the published one, and no staging of modules into the platform checkout.

`DFORGE_CLI` overrides the command (a whitespace-separated command plus flags). A local
install opens the platform's databases itself, so it needs the auth database's connection
string; `ConnectionStrings__AuthDatabase` is taken as set, or built from the same
`DF_PG_*` the loader uses, against the platform's `dforge` database (`DF_AUTH_DB`
overrides the name).
"""
from __future__ import print_function

import os
import shutil
import subprocess

DEFAULT = "npx -y @dforge-core/dforge-cli@latest"


def command():
	"""The CLI as an argv prefix. On Windows `npx` is a .cmd, so it is resolved by PATH."""
	parts = (os.environ.get("DFORGE_CLI") or DEFAULT).split()
	found = shutil.which(parts[0])
	if not found:
		raise SystemExit("cli: %s is not on PATH (install Node.js, or set DFORGE_CLI)" % parts[0])
	return [found] + parts[1:]


def environment():
	"""os.environ plus the auth database's connection string, for a local install."""
	import migrate
	migrate.load_env()
	env = dict(os.environ)
	if not env.get("ConnectionStrings__AuthDatabase"):
		env["ConnectionStrings__AuthDatabase"] = (
			"Host=%s;Port=%s;Database=%s;Username=%s;Password=%s" % (
				env.get("DF_PG_HOST", "localhost"), env.get("DF_PG_PORT", "5432"),
				env.get("DF_AUTH_DB", "dforge"), env.get("DF_PG_USER", "dforge"),
				env.get("DF_PG_PASS", "")))
	return env


def run(args, cwd=None):
	"""(exit code, combined output) of one CLI command."""
	proc = subprocess.Popen(command() + list(args), cwd=cwd, env=environment(),
	                        stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
	out = proc.communicate()[0].decode("utf-8", "replace")
	# npx announces itself on every run; none of it is the CLI's answer.
	out = "\n".join(l for l in out.splitlines() if not l.startswith("npm notice"))
	return proc.returncode, out
