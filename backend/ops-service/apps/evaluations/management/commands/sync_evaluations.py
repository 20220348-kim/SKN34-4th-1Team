"""화면 조회와 독립적으로 Prefect 실행 상태를 Ops DB에 반영한다."""

import signal
from threading import Event

from django.core.management.base import BaseCommand, CommandError
from django.db import DatabaseError, close_old_connections

from apps.evaluations.services import sync_pending_runs


class Command(BaseCommand):
    help = "기존 평가 실행 상태를 동기화합니다. 새 모델 실행을 접수하지 않습니다."

    def add_arguments(self, parser):
        parser.add_argument("--watch", action="store_true")
        parser.add_argument("--interval", type=int, default=10)
        parser.add_argument("--batch-size", type=int, default=25)

    def handle(self, *args, **options):
        interval, batch_size = options["interval"], options["batch_size"]
        if not 2 <= interval <= 300 or not 1 <= batch_size <= 100:
            raise CommandError("interval은 2~300초, batch-size는 1~100이어야 합니다.")
        stopped = Event()
        previous = {}
        if options["watch"]:
            for signum in (signal.SIGTERM, signal.SIGINT):
                previous[signum] = signal.signal(signum, lambda *_: stopped.set())
        try:
            while not stopped.is_set():
                close_old_connections()
                try:
                    count = sync_pending_runs(batch_size=batch_size, interval_seconds=interval)
                except DatabaseError:
                    raise CommandError("상태 동기화 DB 연결·migration을 확인하세요.") from None
                finally:
                    close_old_connections()
                if count or not options["watch"]:
                    self.stdout.write(f"평가 상태 {count}건 확인")
                if not options["watch"]:
                    break
                stopped.wait(interval)
        finally:
            for signum, handler in previous.items():
                signal.signal(signum, handler)
