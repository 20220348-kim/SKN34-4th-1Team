"""서명된 실행기 사용량 증거로 닫힌 예약의 미확인 사용량을 보정한다."""

import json

from django.core.management.base import BaseCommand, CommandError

from apps.evaluations.usage_correction import correct_usage


class Command(BaseCommand):
    help = "Preview usage correction; --apply requires the reviewed receipt SHA-256"

    def add_arguments(self, parser):
        parser.add_argument("--run-id", required=True)
        parser.add_argument("--sequence", required=True, type=int, help="0부터 시작하는 호출 번호")
        parser.add_argument("--actor", required=True)
        parser.add_argument("--reason", required=True)
        parser.add_argument("--request-id", required=True)
        parser.add_argument("--evidence-sha256")
        parser.add_argument("--apply", action="store_true")

    def handle(self, *args, **options):
        try:
            result = correct_usage(
                **{
                    key: options[key]
                    for key in (
                        "run_id",
                        "sequence",
                        "actor",
                        "reason",
                        "request_id",
                        "evidence_sha256",
                        "apply",
                    )
                }
            )
        except (ValueError, AttributeError) as error:
            raise CommandError(str(error)) from None
        self.stdout.write(json.dumps(result, ensure_ascii=False))
