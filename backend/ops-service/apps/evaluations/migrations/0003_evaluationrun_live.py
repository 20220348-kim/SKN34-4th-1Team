from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("evaluations", "0002_evaluationrun_comparison")]
    operations = [
        migrations.AddField(
            model_name="evaluationrun",
            name="execution_mode",
            field=models.CharField(default="replay", max_length=10),
        ),
        migrations.AddField(
            model_name="evaluationrun",
            name="live_config",
            field=models.JSONField(default=dict),
        ),
        migrations.AddField(
            model_name="evaluationrun",
            name="model_api_calls",
            field=models.PositiveSmallIntegerField(default=0, null=True),
        ),
    ]
