"""운영자용 접수 제어. 실행 취소·예산 환급·Prefect 설정 변경은 하지 않는다."""

import json

from django.core.management.base import BaseCommand, CommandError
from django.db import DatabaseError

from apps.evaluations.admission import AdmissionUnavailable, change_admission, status


class Command(BaseCommand):
    help = "Read, pause or resume new Ops evaluation requests with versioned audit records"

    def add_arguments(self, parser):
        actions = parser.add_subparsers(dest="action", required=True)
        actions.add_parser("status")
        for name in ("pause", "resume"):
            action = actions.add_parser(name)
            action.add_argument("--expected-version", type=int, required=True)
            action.add_argument("--request-id", required=True)
            action.add_argument(
                "--actor", required=True, help="운영자가 명시한 변경자; 인증 주체와 구분"
            )
            action.add_argument("--reason", required=True)

    def handle(self, *args, **options):
        try:
            result = (
                status()
                if options["action"] == "status"
                else change_admission(
                    accepting=options["action"] == "resume",
                    **{
                        key: options[key]
                        for key in ("expected_version", "request_id", "actor", "reason")
                    },
                )
            )
        except ValueError as error:
            raise CommandError(str(error)) from None
        except (DatabaseError, AdmissionUnavailable):
            raise CommandError(
                "접수 상태를 확인·변경하지 못했습니다. DB와 migration을 확인하세요."
            ) from None
        self.stdout.write(json.dumps(result, ensure_ascii=False))
