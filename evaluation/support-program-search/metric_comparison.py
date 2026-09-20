"""Compare recomputed evaluation metrics without hiding material changes."""

import math


METRIC_TOLERANCE = 1e-12


def metrics_match(saved, recomputed):
    """Tolerate float metric rounding; keep counts, ranks and structure exact."""
    if type(recomputed) is dict:
        return (type(saved) is dict and saved.keys() == recomputed.keys()
                and all(metrics_match(saved[key], value) for key, value in recomputed.items()))
    if type(recomputed) is list:
        return (type(saved) is list and len(saved) == len(recomputed)
                and all(metrics_match(left, right) for left, right in zip(saved, recomputed)))
    if type(recomputed) is float:
        return (type(saved) in (int, float) and math.isfinite(saved) and math.isfinite(recomputed)
                and math.isclose(saved, recomputed, rel_tol=METRIC_TOLERANCE, abs_tol=METRIC_TOLERANCE))
    return type(saved) is type(recomputed) and saved == recomputed
