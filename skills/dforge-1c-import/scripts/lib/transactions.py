"""Transaction cleanup shared by the migration settlement writers."""
from contextlib import contextmanager


class ConnectionRecoveryError(RuntimeError):
	"""The connection cannot safely be reused; abort rather than try another module."""


def recover(pg):
	"""Rollback before changing mode: psycopg2 forbids it in an active transaction."""
	try:
		pg.rollback()
		pg.autocommit = True
	except Exception as error:
		raise ConnectionRecoveryError("cannot restore migration connection: %s" % error) from error


@contextmanager
def writing(pg):
	"""Writers commit explicitly; on any failure, rollback before restoring autocommit."""
	pg.autocommit = False
	try:
		yield
	except BaseException:
		recover(pg)
		raise
	else:
		pg.autocommit = True
