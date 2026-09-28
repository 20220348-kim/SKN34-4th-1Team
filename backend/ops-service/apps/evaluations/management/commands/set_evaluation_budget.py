"""운영자가 승인한 누적 한도를 설정한다. 기존 예약·사용량을 초기화하지 않는다."""

from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from apps.evaluations.models import EvaluationBudget


class Command(BaseCommand):
    help = "Set cumulative call/output-token limits; does not enable live execution or reset usage"

    def add_arguments(self, parser):
        parser.add_argument("--calls", type=int, required=True)
        parser.add_argument("--output-tokens", type=int, required=True)

    @transaction.atomic
    def handle(self, *args, **options):
        calls, output = options["calls"], options["output_tokens"]
        if not 0 <= calls <= 2**53 - 1 or not 0 <= output <= 2**53 - 1:
            raise CommandError("한도는 0 이상의 정수여야 합니다.")
        budget, _ = EvaluationBudget.objects.get_or_create(pk=1)
        budget = EvaluationBudget.objects.select_for_update().get(pk=budget.pk)
        if calls < budget.allocated_calls or output < budget.allocated_output_tokens:
            raise CommandError("이미 예약·확정한 사용량보다 한도를 낮출 수 없습니다.")
        budget.call_limit, budget.output_token_limit = calls, output
        budget.save(update_fields=["call_limit", "output_token_limit", "updated_at"])
        self.stdout.write(
            f"누적 호출 {budget.allocated_calls}/{calls}, "
            f"출력 토큰 {budget.allocated_output_tokens}/{output} (예약·미확인 포함)"
        )
