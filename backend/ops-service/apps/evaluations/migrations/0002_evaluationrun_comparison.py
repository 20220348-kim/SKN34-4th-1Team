from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("evaluations", "0001_initial")]
    operations = [
        migrations.AddField(
            model_name="evaluationrun",
            name="candidate_capture_id",
            field=models.CharField(default="target-coverage-20260907-v1", max_length=100),
        ),
        migrations.AddField(
            model_name="evaluationrun",
            name="reference_capture_id",
            field=models.CharField(default="target-coverage-20260907-v1", max_length=100),
        ),
        migrations.AddField(
            model_name="evaluationrun",
            name="comparison",
            field=models.JSONField(default=dict),
        ),
    ]
