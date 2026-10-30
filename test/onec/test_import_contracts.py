"""Synthetic contracts; no source database, tenant, or third-party Python packages."""
import contextlib
import datetime as dt
from decimal import Decimal
import io
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace as NS
import unittest
from unittest.mock import Mock, patch

# Importing paths may read .env. Always isolate it from a developer's port project.
_root = tempfile.TemporaryDirectory(prefix="df1c-test-")
_lib = str(Path(__file__).resolve().parents[2] / "skills/dforge-1c-import/scripts/lib")
_saved_root = os.environ.get("DF1C_ROOT")
os.environ["DF1C_ROOT"] = _root.name
sys.path.insert(0, _lib)
import migrate
import delta
import posted
import seedstate
import totals


def tearDownModule():
    _root.cleanup()
    if _lib in sys.path:
        sys.path.remove(_lib)
    if _saved_root is None:
        os.environ.pop("DF1C_ROOT", None)
    else:
        os.environ["DF1C_ROOT"] = _saved_root


class ConversionTests(unittest.TestCase):
    def test_reference_bytes_and_empty_link_vs_dimension(self):
        raw = bytes.fromhex("8899aabbccddeeff0011223344556677")
        self.assertEqual("00112233-4455-6677-8899-aabbccddeeff", migrate.to_uuid(raw))
        self.assertEqual(migrate.to_uuid(raw), migrate.ref_key(memoryview(raw)))
        for empty in (None, bytes(16)):
            self.assertIsNone(migrate.to_uuid(empty))
            self.assertEqual("00000000-0000-0000-0000-000000000000", migrate.ref_key(empty))

    def test_offset_dates_empty_date_and_text_date(self):
        for offset in (0, 2000):
            with self.subTest(offset=offset), patch.object(migrate.store, "year_offset", return_value=offset):
                self.assertEqual(dt.datetime(2024, 2, 29, 12, 34, 56),
                                 migrate.shift_date(dt.datetime(2024 + offset, 2, 29, 12, 34, 56)))
                self.assertIsNone(migrate.shift_date(dt.datetime(1 + offset, 1, 1)))
                self.assertIsNone(migrate.shift_date(None))
                self.assertEqual(dt.date(2024, 2, 29), migrate.text_date("29.02.2024"))

    def test_copy_preserves_precision_and_escapes_fields(self):
        pg = Mock()
        row = [211048242333351937, Decimal("123456789012345678.12345678"),
               None, "a\tb\nc\\d", True, dt.date(2024, 2, 29)]
        migrate.copy_rows(pg, "example", "movement", ["id", "amount", "ref", "text", "flag", "day"], [row])
        args = pg.cursor.return_value.copy_expert.call_args.args
        self.assertEqual('COPY "example"."movement" ("id", "amount", "ref", "text", "flag", "day") FROM STDIN', args[0])
        self.assertEqual("211048242333351937\t123456789012345678.12345678\t\\N\ta\\tb\\nc\\\\d\tt\t2024-02-29\n", args[1].getvalue())

    def test_derived_keys_distinguish_table_and_composite_components(self):
        base = migrate.derived_key("_AccumRg1", ["a", "b\tc", Decimal("1.25")])
        self.assertEqual(base, migrate.derived_key("_AccumRg1", ["a", "b\tc", Decimal("1.25")]))
        self.assertNotEqual(base, migrate.derived_key("_AccumRg1", ["a\tb", "c", Decimal("1.25")]))
        self.assertNotEqual(base, migrate.derived_key("_AccumRg2", ["a", "b\tc", Decimal("1.25")]))


class SettlementTests(unittest.TestCase):
    def test_command_propagates_settlement_status_to_exit_code(self):
        job = NS(entity="movement", blocking=[])
        result = NS(changed=0, new=0, deleted=0, owners=0, read=0, compare=0,
                    write=0, touched=False)
        for apply, status, expected in [(True, "partial", 2), (True, "ready", 0),
                                         (False, "dry_run", 0)]:
            with self.subTest(status=status), contextlib.ExitStack() as stack:
                stack.enter_context(patch.object(sys, "argv", ["delta", "--no-mark"] +
                                                (["--apply"] if apply else [])))
                for obj, name, value in [
                    (migrate, "load_env", None), (migrate, "column_map", {"stock": {"movement": {}}}),
                    (migrate, "source_schema", {}), (migrate, "pg_connect", Mock()),
                    (migrate, "source_connect", Mock()), (migrate, "jobs_for", [job]),
                    (delta, "modules_in_order", ["stock"]),
                    (delta, "marks", {("stock", "movement"): (b"12345678", None)}),
                    (delta.store, "horizon", b"12345678"), (delta.store, "manifest", {"tables": {}}),
                    (delta, "classify", ("objects", None)), (delta, "run_entity", result),
                    (delta, "settle", delta.SettleResult(status, ["diagnostic"])),
                ]:
                    stack.enter_context(patch.object(obj, name, return_value=value))
                base = Mock(now=b"12345678", keys=0, seconds=0)
                base.load_alive.return_value = 0
                stack.enter_context(patch.object(delta, "Infobase", return_value=base))
                output = stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
                self.assertEqual(expected, delta.main())
                self.assertIn("stock: status " + status, output.getvalue())

    def run_settle(self, *, marker_ok=True, token="token", drift=0, totals_off=0,
                   apply=True, changed=True, crash=False):
        pg = Mock()
        pg.cursor.return_value.fetchall.return_value = [("monthly", "movement")]
        reg = NS(journal_entity="movement", module="stock", code="balance")
        plan = NS(code="monthly")
        result = NS(job=NS(entity="movement", schema="stock"), touched=changed)
        with contextlib.ExitStack() as stack:
            for obj, name, value in [
                (delta, "unsettled", {"movement"}),
                (migrate, "fill_missing", []),
                (seedstate, "registers", [reg]),
                (seedstate, "seed", (1, 1, None)),
                (seedstate, "drift", drift),
                (totals, "plans", [plan]),
                (totals, "rebuild", None),
                (totals, "check", (None, totals_off)),
                (posted, "survey", ([(None, "stock.movement")], None, None)),
                (posted, "converge", ({"marked": 1}, marker_ok)),
            ]:
                stack.enter_context(patch.object(obj, name, return_value=value))
            if crash:
                stack.enter_context(patch.object(totals, "rebuild", side_effect=RuntimeError("interrupted")))
            outcome = delta.settle(pg, "stock", [result], apply, token)
        deleted = any("DELETE FROM df1c.unsettled" in str(c)
                      for c in pg.cursor.return_value.execute.call_args_list)
        return outcome, deleted

    def test_each_incomplete_stage_blocks_cutover_and_keeps_retry_marker(self):
        for kwargs in ({"marker_ok": False}, {"token": None}, {"drift": 1}, {"totals_off": 1}):
            with self.subTest(**kwargs):
                outcome, deleted = self.run_settle(**kwargs)
                self.assertEqual("partial", outcome.status)
                self.assertEqual(2, delta.settlement_exit_code([outcome], True))
                self.assertFalse(deleted)

    def test_retry_without_new_changes_finishes_persisted_unsettled_entity(self):
        first, _ = self.run_settle(marker_ok=False)
        retry, deleted = self.run_settle(changed=False)
        self.assertEqual(2, delta.settlement_exit_code([first, retry], True))
        self.assertEqual("ready", retry.status)
        self.assertEqual(0, delta.settlement_exit_code([retry], True))
        self.assertTrue(deleted)

    def test_crash_propagates_and_retry_can_settle(self):
        with self.assertRaisesRegex(RuntimeError, "interrupted"):
            self.run_settle(crash=True)
        retry, deleted = self.run_settle(changed=False)
        self.assertEqual("ready", retry.status)
        self.assertTrue(deleted)

    def test_dry_run_does_not_certify_readiness_or_clear_markers(self):
        outcome, deleted = self.run_settle(apply=False)
        self.assertEqual("dry_run", outcome.status)
        self.assertEqual(0, delta.settlement_exit_code([outcome], False))
        self.assertFalse(deleted)


class ReloadRestartTests(unittest.TestCase):
    def test_truncate_reload_after_failure_replaces_partial_commits(self):
        # Model only transaction/COPY boundaries, not PostgreSQL SQL semantics.
        class Target:
            def __init__(self):
                self.committed = {"a": ["old"], "b": ["old"]}
                self.pending = {k: list(v) for k, v in self.committed.items()}
            def cursor(self):
                return self
            def execute(self, sql, *args):
                if sql.startswith("TRUNCATE"):
                    self.pending[sql.split('"')[-2]] = []
            def fetchone(self):
                return (0,)
            def commit(self):
                self.committed = {k: list(v) for k, v in self.pending.items()}
            def rollback(self):
                self.pending = {k: list(v) for k, v in self.committed.items()}
        class Source:
            def cursor(self):
                return self
            def execute(self, table):
                table = table.rsplit(" ", 1)[-1]
                self.batch = [(table + "-1",), (table + "-2",)]
            def fetchmany(self, size):
                batch, self.batch = self.batch, []
                return batch
        pg, source = Target(), Source()
        jobs = [NS(entity=t, schema="stock", table=t, source=t, pairs=[("id", "id")],
                   derived=None, rows=2, blocking=[]) for t in ("a", "b")]
        args = NS(module="stock", entity=None, force=False, truncate=True, no_placeholders=True)
        fail = [True]
        def copy(pg, schema, table, columns, rows):
            if table == "b" and fail[0]:
                raise RuntimeError("COPY interrupted")
            pg.pending[table].extend(r[0] for r in rows)
        with contextlib.ExitStack() as stack:
            for name, value in [("column_map", {}), ("source_schema", {}), ("pg_connect", pg),
                                ("jobs_for", jobs), ("source_connect", source)]:
                stack.enter_context(patch.object(migrate, name, return_value=value))
            stack.enter_context(patch.object(migrate, "bind_enums", side_effect=lambda j, _: j))
            stack.enter_context(patch.object(migrate, "reading", side_effect=lambda j: j.table))
            stack.enter_context(patch.object(migrate, "converted", side_effect=lambda j, rows: rows))
            stack.enter_context(patch.object(migrate, "copy_rows", side_effect=copy))
            stack.enter_context(patch.object(migrate.store, "horizon", return_value=None))
            stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
            with self.assertRaisesRegex(RuntimeError, "COPY interrupted"):
                migrate.cmd_run(args)
            self.assertEqual({"a": ["a-1", "a-2"], "b": []}, pg.committed)
            pg.rollback()
            fail[0] = False
            self.assertEqual(0, migrate.cmd_run(args))
            self.assertEqual({"a": ["a-1", "a-2"], "b": ["b-1", "b-2"]}, pg.committed)


class StrictConnection:
    """Models psycopg2's transaction/mode rules, not SQL or database contents."""
    def __init__(self):
        self.mode = True
        self.active = False
        self.failed = False
        self.rollback_calls = 0
        self.commit_calls = 0
        self.rollback_error = None
        self.write_error = None
        self.fetchall = Mock(return_value=[])
        self.fetchone = Mock(return_value=(0, 0, 0))
        self.rowcount = 1

    @property
    def autocommit(self):
        return self.mode

    @autocommit.setter
    def autocommit(self, value):
        if self.active:
            raise RuntimeError("set_session cannot be used inside a transaction")
        self.mode = value

    def cursor(self):
        return self

    def execute(self, sql, *args):
        if self.failed:
            raise RuntimeError("current transaction is aborted")
        if not self.mode:
            self.active = True

    def executemany(self, sql, rows):
        self.execute(sql)
        if self.write_error:
            self.failed = True
            raise self.write_error

    def commit(self):
        if self.failed:
            raise RuntimeError("cannot commit failed transaction")
        self.commit_calls += 1
        self.active = False

    def rollback(self):
        self.rollback_calls += 1
        if self.rollback_error:
            raise self.rollback_error
        self.failed = self.active = False


class TransactionRecoveryTests(unittest.TestCase):
    def test_settlement_writers_rollback_before_restoring_mode(self):
        for stage, failure_type in [("placeholders", ValueError), ("seed", ValueError),
                                     ("seed", SystemExit)]:
            with self.subTest(stage=stage, failure=failure_type.__name__), contextlib.ExitStack() as stack:
                pg = StrictConnection()
                original = failure_type("original writer failure")
                def fail(*args, **kwargs):
                    pg.execute("write")
                    pg.failed = True
                    raise original
                reg = NS(journal_entity="movement")
                stack.enter_context(patch.object(delta, "unsettled", return_value={"movement"}))
                stack.enter_context(patch.object(migrate, "fill_missing",
                    side_effect=fail if stage == "placeholders" else lambda *a, **k: []))
                stack.enter_context(patch.object(seedstate, "registers", return_value=[reg]))
                stack.enter_context(patch.object(seedstate, "seed", side_effect=fail))
                with self.assertRaises(failure_type) as caught:
                    delta.settle(pg, "stock", [NS(job=NS(entity="movement", schema="stock"), touched=True)], True, None)
                self.assertIs(original, caught.exception)
                self.assertTrue(pg.autocommit)
                self.assertFalse(pg.active)
                self.assertFalse(pg.failed)
                self.assertEqual(1, pg.rollback_calls)

    def test_totals_write_failure_rolls_back_current_year_preserving_previous_commit(self):
        pg = StrictConnection()
        pg.fetchall.side_effect = [[(dt.date(2023, 1, 1), 10), (dt.date(2024, 1, 1), 20)], []]
        original = ValueError("second year write failed")
        write = pg.executemany
        count = [0]
        def insert(sql, rows):
            count[0] += 1
            if count[0] == 2:
                pg.write_error = original
            write(sql, rows)
        pg.executemany = insert
        with contextlib.ExitStack() as stack:
            for name, value in [("unplaceable", "check"), ("select", "read"),
                                ("columns", (["period"], ["amount"]))]:
                stack.enter_context(patch.object(totals, name, return_value=value))
            with self.assertRaises(ValueError) as caught:
                totals.rebuild(pg, NS(period_field="period", totals="stock.totals"))
        self.assertIs(original, caught.exception)
        self.assertEqual(1, pg.commit_calls)
        self.assertEqual(1, pg.rollback_calls)
        self.assertTrue(pg.autocommit)
        self.assertFalse(pg.active)

    def test_command_recovers_before_next_module_and_stops_if_recovery_fails(self):
        import transactions
        for rollback_fails, writer_cleanup in ((False, False), (True, False), (True, True)):
            with self.subTest(rollback_fails=rollback_fails, writer_cleanup=writer_cleanup), contextlib.ExitStack() as stack:
                pg = StrictConnection()
                if rollback_fails:
                    pg.rollback_error = RuntimeError("connection lost")
                modules = ["first", "second"]
                job = NS(entity="movement", blocking=[])
                result = NS(changed=0, new=0, deleted=0, owners=0, read=0, compare=0,
                            write=0, touched=False)
                visited = []
                def settle(pg, module, *args):
                    visited.append(module)
                    if module == "first":
                        if writer_cleanup:
                            with transactions.writing(pg):
                                pg.execute("write")
                                raise ValueError("first writer failed")
                        pg.autocommit = False
                        pg.execute("write")
                        pg.failed = True
                        raise ValueError("first failed")
                    self.assertTrue(pg.autocommit)
                    self.assertFalse(pg.active)
                    self.assertFalse(pg.failed)
                    return delta.SettleResult("ready", [])
                def run_entity(*args):
                    if args[4] == "second":
                        self.assertTrue(pg.autocommit)
                        self.assertFalse(pg.active)
                    return result
                stack.enter_context(patch.object(sys, "argv", ["delta", "--apply", "--no-mark"]))
                for obj, name, value in [
                    (migrate, "load_env", None),
                    (migrate, "column_map", {m: {"movement": {}} for m in modules}),
                    (migrate, "source_schema", {}), (migrate, "pg_connect", pg),
                    (migrate, "source_connect", Mock()), (migrate, "jobs_for", [job]),
                    (delta, "modules_in_order", modules),
                    (delta, "marks", {(m, "movement"): (b"12345678", None) for m in modules}),
                    (delta.store, "horizon", b"12345678"), (delta.store, "manifest", {"tables": {}}),
                    (delta, "classify", ("objects", None)),
                ]:
                    stack.enter_context(patch.object(obj, name, return_value=value))
                stack.enter_context(patch.object(delta, "settle", side_effect=settle))
                stack.enter_context(patch.object(delta, "run_entity", side_effect=run_entity))
                base = Mock(now=b"12345678", keys=0, seconds=0)
                base.load_alive.return_value = 0
                stack.enter_context(patch.object(delta, "Infobase", return_value=base))
                output = stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
                if rollback_fails:
                    with self.assertRaises(transactions.ConnectionRecoveryError):
                        delta.main()
                    self.assertEqual(["first"], visited)
                else:
                    self.assertEqual(2, delta.main())
                    self.assertEqual(modules, visited)
                    self.assertIn("ValueError: first failed", output.getvalue())
                self.assertEqual(1, pg.rollback_calls)

    def test_failed_writer_cleanup_cannot_be_converted_to_partial_and_continued(self):
        import transactions
        pg = StrictConnection()
        original = ValueError("writer failed")
        pg.rollback_error = RuntimeError("connection lost")
        with self.assertRaises(transactions.ConnectionRecoveryError) as caught:
            with transactions.writing(pg):
                pg.execute("write")
                raise original
        self.assertIs(original, caught.exception.__cause__.__context__)
        self.assertFalse(pg.autocommit)


if __name__ == "__main__":
    unittest.main()
