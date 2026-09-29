"""종료된 평가의 미사용 예약을 미리 보거나 명시적으로 정리한다."""

import json

from django.core.management.base import BaseCommand, CommandError

from apps.evaluations.budget_cleanup import cleanup_reservation
from apps.evaluations.prefect_client import PrefectUnavailable


class Command(BaseCommand):
    help = "Preview unused budget cleanup; --apply records it atomically without model calls"

    def add_arguments(self, parser):
        parser.add_argument("--run-id", required=True)
        parser.add_argument("--actor", required=True, help="CLI 운영자가 명시하는 변경자")
        parser.add_argument("--reason", required=True)
        parser.add_argument("--request-id", required=True, help="재시도에 재사용할 정리 요청 UUID")
        parser.add_argument("--apply", action="store_true", help="생략하면 쓰기 없는 미리보기")

    def handle(self, *args, **options):
        try:
            result = cleanup_reservation(
                **{
                    key: options[key]
                    for key in ("run_id", "actor", "reason", "request_id", "apply")
                }
            )
        except (ValueError, AttributeError) as error:
            raise CommandError(str(error)) from None
        except PrefectUnavailable:
            raise CommandError(
                "Prefect 종료 증거를 조회하지 못했습니다. 예약을 유지합니다."
            ) from None
        self.stdout.write(json.dumps(result, ensure_ascii=False))
