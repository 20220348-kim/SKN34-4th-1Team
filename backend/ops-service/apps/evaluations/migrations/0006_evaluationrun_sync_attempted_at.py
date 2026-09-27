from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("evaluations", "0005_evaluationrun_recovery")]

    operations = [
        migrations.AddField(
            model_name="evaluationrun",
            name="sync_attempted_at",
            field=models.DateTimeField(null=True),
        ),
    ]
