import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("evaluations", "0014_budget_cleanup")]

    operations = [
        migrations.CreateModel(
            name="EvaluationUsageCorrection",
            fields=[
                ("request_id", models.UUIDField(primary_key=True, serialize=False)),
                ("actor", models.CharField(max_length=150)),
                ("reason", models.CharField(max_length=1000)),
                ("evidence_sha256", models.CharField(max_length=64, unique=True)),
                ("response_id", models.CharField(max_length=185, unique=True)),
                ("evidence_raw", models.TextField()),
                ("input_tokens", models.PositiveBigIntegerField()),
                ("output_tokens", models.PositiveBigIntegerField()),
                ("original_call", models.JSONField()),
                ("before", models.JSONField()),
                ("after", models.JSONField()),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                (
                    "call",
                    models.OneToOneField(
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="correction",
                        to="evaluations.evaluationbudgetcall",
                    ),
                ),
            ],
            options={
                "constraints": [
                    models.CheckConstraint(
                        condition=~models.Q(actor="") & ~models.Q(reason=""),
                        name="usage_correction_attribution",
                    )
                ]
            },
        )
    ]
