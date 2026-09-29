"""Read-only checks of migration history and the columns needed by installed models."""

from django.apps import apps
from django.db import connection
from django.db.migrations.executor import MigrationExecutor


def schema_is_ready():
    executor = MigrationExecutor(connection)
    executor.loader.check_consistent_history(connection)
    if executor.loader.detect_conflicts() or executor.migration_plan(
        executor.loader.graph.leaf_nodes()
    ):
        return False
    # A migration history alone does not prove the actual tables/columns exist.
    # WHERE 1=0 validates columns without reading application rows.
    quote = connection.ops.quote_name
    with connection.cursor() as cursor:
        for model in apps.get_models(include_auto_created=True):
            if model._meta.managed and not model._meta.proxy:
                columns = ", ".join(quote(field.column) for field in model._meta.local_fields)
                cursor.execute(f"SELECT {columns} FROM {quote(model._meta.db_table)} WHERE 1=0")
    return True
