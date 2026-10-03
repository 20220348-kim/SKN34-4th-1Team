from django.core.management.base import BaseCommand, CommandError

from apps.evaluations.daily_budget import change_daily_limits


class Command(BaseCommand):
    help = (
        "서울 날짜별 호출·입력·출력 한도를 감사 기록과 함께 설정합니다. "
        "모델 실행은 활성화하지 않습니다."
    )

    def add_arguments(self, parser):
        parser.add_argument("--calls", type=int)
        parser.add_argument("--input-tokens", type=int)
        parser.add_argument("--output-tokens", type=int)
        parser.add_argument("--disable", action="store_true")
        parser.add_argument("--actor", required=True)
        parser.add_argument("--reason", required=True)
        parser.add_argument("--request-id", required=True)

    def handle(self, **options):
        try:
            change = change_daily_limits(
                **{
                    key: options[key]
                    for key in (
                        "calls",
                        "input_tokens",
                        "output_tokens",
                        "disable",
                        "actor",
                        "reason",
                        "request_id",
                    )
                }
            )
        except (ValueError, TypeError, AttributeError) as exc:
            raise CommandError(str(exc)) from exc
        self.stdout.write(f"일별 정책 요청 {change.request_id}: {change.policy_snapshot}")
