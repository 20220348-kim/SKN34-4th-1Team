import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("evaluations", "0013_budget_change_audit")]

    operations = [
        migrations.CreateModel(
            name="EvaluationBudgetCleanup",
            fields=[
                ("request_id", models.UUIDField(primary_key=True, serialize=False)),
                ("actor", models.CharField(max_length=150)),
                ("reason", models.CharField(max_length=1000)),
                ("evidence", models.JSONField()),
                ("worker_id", models.UUIDField(null=True)),
                ("calls", models.JSONField()),
                ("before", models.JSONField()),
                ("after", models.JSONField()),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                (
                    "reservation",
                    models.OneToOneField(
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="cleanup",
                        to="evaluations.evaluationbudgetreservation",
                    ),
                ),
            ],
            options={
                "constraints": [
                    models.CheckConstraint(
                        condition=~models.Q(actor="") & ~models.Q(reason=""),
                        name="budget_cleanup_attribution",
                    )
                ]
            },
        )
    ]
