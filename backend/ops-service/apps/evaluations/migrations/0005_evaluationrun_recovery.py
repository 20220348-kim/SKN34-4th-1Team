import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("evaluations", "0004_evaluation_review_baseline")]

    operations = [
        migrations.AddField(
            model_name="evaluationrun",
            name="source_run",
            field=models.ForeignKey(
                null=True,
                on_delete=django.db.models.deletion.PROTECT,
                related_name="recoveries",
                to="evaluations.evaluationrun",
            ),
        ),
        migrations.AddField(
            model_name="evaluationrun",
            name="recovery_config",
            field=models.JSONField(default=dict),
        ),
    ]
