"""운영자가 승인한 누적 한도를 설정한다. 기존 예약·사용량을 초기화하지 않는다."""

from django.core.management.base import BaseCommand, CommandError

from apps.evaluations.budget_reporting import change_limits


class Command(BaseCommand):
    help = "Set cumulative call/output-token limits; does not enable live execution or reset usage"

    def add_arguments(self, parser):
        parser.add_argument("--calls", type=int, required=True)
        parser.add_argument("--output-tokens", type=int, required=True)
        parser.add_argument(
            "--input-tokens", type=int, help="입력 누적 한도. 활성화 후 변경 시 항상 명시"
        )
        parser.add_argument("--actor", required=True, help="CLI 운영자가 명시하는 변경자")
        parser.add_argument("--reason", required=True)
        parser.add_argument("--request-id", required=True, help="동일 요청 재시도에 재사용할 UUID")

    def handle(self, *args, **options):
        try:
            change = change_limits(
                **{
                    key: options[key]
                    for key in (
                        "calls",
                        "output_tokens",
                        "input_tokens",
                        "actor",
                        "reason",
                        "request_id",
                    )
                }
            )
        except (ValueError, AttributeError) as error:
            raise CommandError(str(error)) from None
        input_limit = change.input_token_limit if change.input_token_limit is not None else "미설정"
        self.stdout.write(
            f"한도 변경 기록 {change.request_id}: 호출 {change.call_limit}, "
            f"입력 토큰 {input_limit}, 출력 토큰 {change.output_token_limit}. "
            "같은 요청 재시도는 기록만 확인합니다."
        )
