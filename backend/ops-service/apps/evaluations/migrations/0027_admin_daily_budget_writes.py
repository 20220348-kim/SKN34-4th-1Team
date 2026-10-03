import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("evaluations", "0026_daily_evaluation_budget"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.AddField(
            model_name="evaluationdailybudgetchange",
            name="source",
            field=models.CharField(default="CLI", editable=False, max_length=10),
        ),
        migrations.AddField(
            model_name="evaluationdailybudgetchange",
            name="authenticated_actor",
            field=models.ForeignKey(
                null=True,
                on_delete=django.db.models.deletion.PROTECT,
                related_name="+",
                to=settings.AUTH_USER_MODEL,
            ),
        ),
        migrations.AddField(
            model_name="evaluationdailybudgetchange",
            name="expected_revision",
            field=models.CharField(max_length=64, null=True),
        ),
        migrations.AddConstraint(
            model_name="evaluationdailybudgetchange",
            constraint=models.CheckConstraint(
                condition=models.Q(
                    source="CLI", authenticated_actor__isnull=True, expected_revision__isnull=True
                )
                | models.Q(
                    source="CORE_ADMIN",
                    authenticated_actor__isnull=False,
                    expected_revision__isnull=False,
                ),
                name="daily_budget_change_actor_source",
            ),
        ),
    ]
