from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("evaluations", "0008_case_reviews")]

    operations = [
        migrations.AddField(
            model_name="evaluationrun", name="execution_spec", field=models.JSONField(default=dict)
        ),
        migrations.AddField(
            model_name="evaluationrun",
            name="execution_spec_sha256",
            field=models.CharField(blank=True, max_length=64),
        ),
    ]
