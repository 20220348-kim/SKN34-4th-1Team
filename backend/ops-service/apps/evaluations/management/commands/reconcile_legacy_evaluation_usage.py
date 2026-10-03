"""과거 저장 응답의 사용량 검토 미리보기. --apply와 확인한 해시가 있어야 반영한다."""

import json

from django.core.management.base import BaseCommand, CommandError

from apps.evaluations.legacy_usage import reconcile_legacy_usage


class Command(BaseCommand):
    help = "Preview legacy saved usage; --apply requires the reviewed evidence SHA-256"

    def add_arguments(self, parser):
        parser.add_argument("--run-id", required=True)
        parser.add_argument("--actor", required=True, help="CLI 운영자가 명시한 검토자")
        parser.add_argument("--reason", required=True)
        parser.add_argument("--request-id", required=True)
        parser.add_argument("--evidence-sha256")
        parser.add_argument("--apply", action="store_true")

    def handle(self, *args, **options):
        try:
            result = reconcile_legacy_usage(
                **{
                    key: options[key]
                    for key in (
                        "run_id",
                        "actor",
                        "reason",
                        "request_id",
                        "evidence_sha256",
                        "apply",
                    )
                }
            )
        except ValueError as error:
            raise CommandError(str(error)) from None
        self.stdout.write(json.dumps(result, ensure_ascii=False))
