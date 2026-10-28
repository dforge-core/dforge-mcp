# -*- coding: utf-8 -*-
"""Which 1C object belongs to which dForge module - this infobase's half of the port.

Start it from the configuration's own subsystems rather than by hand:

    python 1c.py subsystems --contours --acyclic   # -> out/contours_subsystems.py

and copy that file over this one. Rename the module codes, move objects between contours
where the subsystems guessed wrong, and keep the names below. `binding.py` in the library
lists everything a project may say; only CONTOURS and CODES are required.
"""
import collections

# module code -> {"objects": [1C object names], ...}, in install order
CONTOURS = collections.OrderedDict([
])

# 1C object name -> the entity code to give it, where the derived one is wrong
CODES = {}

# (module, entity, column) -> the module that should own the column, for a reference that
# would otherwise invert a dependency
EXTENSIONS = {}

# 1C objects an authored spec covers (generation skips them)
DONE = set()

# 1C object name -> "module.entity" for the objects an authored spec owns: a reference to
# one resolves to that entity instead of generating a second copy
HAND_ENTITIES = {}

# The integrator's own prefixes (e.g. u"мсб" for мсбЗаказ): what makes an object the
# client's rather than the vendor's. Measure them: list the lowercase runs before a capital
# across the object names (`1c.py custom`). Empty means nothing counts as the client's.
CLIENT_PREFIXES = ()

# Prefixes of a third-party toolkit embedded in the configuration: neither the vendor's
# nor the client's. Dropped from derived names like the client's.
TOOLKIT_PREFIXES = ()

# Where the minimal entities for catalogs the port only points at are generated
STUB_MODULE = None


def names(contour):
	"""The 1C object names one contour owns."""
	return list(contour["objects"])
